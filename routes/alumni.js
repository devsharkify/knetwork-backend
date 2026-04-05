const router = require('express').Router();
const supabase = require('../config/supabase');
const { scrapeProfile } = require('../services/proxycurl');
const WA = require('../services/whatsapp');
const { draftIntroMessage } = require('../services/claude');
const { requireAuth, requireVerified } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const logger = require('../config/logger');

// GET /alumni — directory with search + filters
router.get('/', requireAuth, async (req, res) => {
  const { q, batch, city, type, tag, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('v_alumni_with_tags')
    .select('*', { count: 'exact' })
    .eq('is_active', true)
    .neq('id', req.alumni.id);

  // Chapter admin scoping
  if (req.chapterCity) query = query.eq('city', req.chapterCity);

  // Visibility: only show profiles that allow viewing
  query = query.or(`visibility.eq.all_alumni,id.eq.${req.alumni.id}`);

  if (q) query = query.ilike('full_name', `%${q}%`);
  if (batch) query = query.eq('batch_year', parseInt(batch));
  if (city) query = query.eq('city', city);

  query = query.order('batch_year', { ascending: false })
               .range(offset, offset + parseInt(limit) - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ alumni: data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// GET /alumni/:id — single profile
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('v_alumni_with_tags')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Alumni not found' });

  // Enforce visibility
  if (data.visibility === 'private' && data.id !== req.alumni.id) {
    return res.status(403).json({ error: 'This profile is private' });
  }

  if (data.visibility === 'connections_only' && data.id !== req.alumni.id) {
    const { data: conn } = await supabase
      .from('connections')
      .select('id')
      .or(`requester_id.eq.${req.alumni.id},recipient_id.eq.${req.alumni.id}`)
      .or(`requester_id.eq.${data.id},recipient_id.eq.${data.id}`)
      .eq('status', 'accepted')
      .single();

    if (!conn) return res.status(403).json({ error: 'This profile is visible to connections only' });
  }

  res.json({ alumni: data });
});

// PATCH /alumni/me — update own profile
router.patch('/me', requireAuth, validate(schemas.updateProfile), async (req, res) => {
  const { data, error } = await supabase
    .from('alumni_profiles')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.alumni.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ alumni: data });
});

// POST /alumni/me/sync-linkedin — trigger Proxycurl scrape
router.post('/me/sync-linkedin', requireAuth, async (req, res) => {
  const { linkedin_url } = req.body;
  const url = linkedin_url || req.alumni.linkedin_url;
  if (!url) return res.status(400).json({ error: 'No LinkedIn URL on profile' });

  res.json({ ok: true, message: 'Sync queued — updates will appear shortly' });

  // Async sync
  scrapeProfile(url, req.alumni.id)
    .then(r => logger.info('Manual LinkedIn sync', { id: req.alumni.id, ok: r.ok }))
    .catch(e => logger.error('LinkedIn sync error', e));
});

// GET /alumni/me/events — events attended (profile history)
router.get('/me/events', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('event_checkins')
    .select(`
      checked_in_at,
      events(id, title, event_date, chapter_display, attending_count),
      people_met:event_checkins!event_id(
        alumni_profiles(id, full_name, current_title, current_company, initials, city)
      )
    `)
    .eq('alumni_id', req.alumni.id)
    .order('checked_in_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data });
});

// POST /alumni/connections — send connection request
router.post('/connections', requireAuth, requireVerified, validate(schemas.connectRequest), async (req, res) => {
  const { recipient_id, note } = req.body;

  if (recipient_id === req.alumni.id) {
    return res.status(400).json({ error: 'Cannot connect with yourself' });
  }

  const { data: recipient } = await supabase
    .from('alumni_profiles')
    .select('id, full_name, whatsapp_number, wa_notifications')
    .eq('id', recipient_id)
    .single();

  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

  const { data, error } = await supabase
    .from('connections')
    .upsert({
      requester_id: req.alumni.id,
      recipient_id,
      note: note || null,
      status: 'pending'
    }, { onConflict: 'requester_id,recipient_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // WA notification to recipient
  if (recipient.wa_notifications) {
    WA.kmatchAlert(recipient, req.alumni, null).catch(e => logger.error('WA connect notify failed', e));
  }

  res.status(201).json({ connection: data });
});

// PATCH /alumni/connections/:id — accept/decline
router.patch('/connections/:id', requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!['accepted', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'Status must be accepted or declined' });
  }

  const { data, error } = await supabase
    .from('connections')
    .update({ status, connected_at: status === 'accepted' ? new Date().toISOString() : null })
    .eq('id', req.params.id)
    .eq('recipient_id', req.alumni.id) // can only update your own received requests
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Connection not found' });

  res.json({ connection: data });
});

// POST /alumni/warm-intro — request A→B intro via C
router.post('/warm-intro', requireAuth, requireVerified, validate(schemas.warmIntro), async (req, res) => {
  const { target_id, connector_id, message } = req.body;

  const [{ data: target }, { data: connector }] = await Promise.all([
    supabase.from('alumni_profiles').select('id, full_name, current_title, whatsapp_number').eq('id', target_id).single(),
    supabase.from('alumni_profiles').select('id, full_name, current_title, whatsapp_number, wa_notifications').eq('id', connector_id).single()
  ]);

  if (!target || !connector) return res.status(404).json({ error: 'Alumni not found' });

  // Draft intro message with Claude
  const draftMsg = message || await draftIntroMessage(req.alumni, target, connector);

  // Log intro request
  await supabase.from('warm_intro_requests').insert({
    requester_id: req.alumni.id,
    target_id,
    connector_id,
    message: draftMsg,
    status: 'pending'
  });

  // WA to connector
  if (connector.wa_notifications) {
    WA.warmIntroRequest(connector, req.alumni, target).catch(e => logger.error('WA intro failed', e));
  }

  res.json({ ok: true, draft_message: draftMsg, sent_to: connector.full_name });
});

// GET /alumni/me/connections — my connections list
router.get('/me/connections', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('connections')
    .select(`
      id, status, connected_at, note,
      requester:requester_id(id, full_name, current_title, current_company, city, initials),
      recipient:recipient_id(id, full_name, current_title, current_company, city, initials)
    `)
    .or(`requester_id.eq.${req.alumni.id},recipient_id.eq.${req.alumni.id}`)
    .eq('status', 'accepted')
    .order('connected_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ connections: data });
});

// GET /alumni/companies — alumni company directory
router.get('/directory/companies', requireAuth, async (req, res) => {
  const { q, sector, filter, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('startup_pitches')
    .select(`
      *, 
      founder:founder_id(id, full_name, batch_year, current_title, initials, city)
    `, { count: 'exact' })
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (q) query = query.ilike('startup_name', `%${q}%`);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ companies: data, total: count });
});

module.exports = router;
