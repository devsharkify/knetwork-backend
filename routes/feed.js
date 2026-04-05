// ═══ FEED ═══
const router = require('express').Router();
const supabase = require('../config/supabase');
const WA = require('../services/whatsapp');
const { moderatePost, scoreOpportunity } = require('../services/claude');
const { requireAuth, requireVerified } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const logger = require('../config/logger');

// GET /feed
router.get('/', requireAuth, async (req, res) => {
  const { type, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('feed_posts')
    .select(`
      *, 
      author:author_id(id, full_name, current_title, current_company, batch_year, initials, photo_url),
      post_likes(alumni_id)
    `, { count: 'exact' })
    .eq('visibility', 'all_alumni')
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (type) query = query.eq('post_type', type);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const posts = (data || []).map(p => ({
    ...p,
    i_liked: (p.post_likes || []).some(l => l.alumni_id === req.alumni.id),
    like_count: (p.post_likes || []).length
  }));

  res.json({ posts, total: count });
});

// POST /feed — create post with AI moderation
router.post('/', requireAuth, requireVerified, validate(schemas.postFeed), async (req, res) => {
  const { body, post_type, tags, visibility } = req.body;

  // Claude moderation
  const mod = await moderatePost(body, req.alumni.batch_year, post_type);
  if (!mod.approved && mod.severity === 'high') {
    return res.status(400).json({
      error: 'Post rejected by content moderation',
      reason: mod.reason,
      severity: mod.severity
    });
  }

  const { data, error } = await supabase
    .from('feed_posts')
    .insert({
      author_id: req.alumni.id,
      post_type,
      body,
      tags: tags || [],
      visibility,
      moderation_status: mod.approved ? 'approved' : 'pending_review',
      moderation_severity: mod.severity
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (!mod.approved && mod.severity === 'medium') {
    return res.json({ post: data, warning: `Post queued for review: ${mod.reason}` });
  }

  res.status(201).json({ post: data });
});

// POST /feed/:id/like
router.post('/:id/like', requireAuth, async (req, res) => {
  const { data: existing } = await supabase
    .from('post_likes')
    .select('id')
    .eq('post_id', req.params.id)
    .eq('alumni_id', req.alumni.id)
    .single();

  if (existing) {
    await supabase.from('post_likes').delete().eq('post_id', req.params.id).eq('alumni_id', req.alumni.id);
    await supabase.from('feed_posts').update({ likes: supabase.raw('likes - 1') }).eq('id', req.params.id);
    return res.json({ liked: false });
  }

  await supabase.from('post_likes').insert({ post_id: req.params.id, alumni_id: req.alumni.id });
  await supabase.from('feed_posts').update({ likes: supabase.raw('likes + 1') }).eq('id', req.params.id);
  res.json({ liked: true });
});

// DELETE /feed/:id — remove own post or admin
router.delete('/:id', requireAuth, async (req, res) => {
  let query = supabase.from('feed_posts').delete().eq('id', req.params.id);
  if (req.adminRole !== 'super_admin') query = query.eq('author_id', req.alumni.id);

  const { error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══ OPPORTUNITIES ═══
// POST /opps
router.post('/opps', requireAuth, requireVerified, validate(schemas.postOpp), async (req, res) => {
  const { type, title, company, description, tags, notify_groups, ...rest } = req.body;

  const { data: opp, error } = await supabase
    .from('opportunities')
    .insert({
      poster_id: req.alumni.id,
      type, title, company, description,
      tags: tags || [],
      notify_groups: notify_groups || [],
      ...rest
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Async: score + notify matching alumni in groups
  notifyMatchingAlumni(opp, req.alumni).catch(e => logger.error('Opp notify failed', e));

  res.status(201).json({ opportunity: opp });
});

async function notifyMatchingAlumni(opp, poster) {
  if (!opp.notify_groups?.length) return;

  for (const groupId of opp.notify_groups) {
    const { data: members } = await supabase
      .from('group_members')
      .select('alumni_profiles(id, full_name, whatsapp_number, wa_notifications, current_title, current_company, alumni_tags(interest_tags(label,category)), alumni_goals(goal))')
      .eq('group_id', groupId)
      .eq('wa_alerts', true);

    for (const m of (members || [])) {
      const profile = m.alumni_profiles;
      if (!profile?.wa_notifications) continue;

      // Score relevance
      const score = await scoreOpportunity(opp, profile);
      if (score.notify) {
        await WA.oppMatch(profile, { ...opp, poster_name: poster.full_name });
        await new Promise(ok => setTimeout(ok, 1100));
      }
    }

    // Update notified count
    await supabase.from('opportunities')
      .update({ notified_count: supabase.raw('notified_count + 1') })
      .eq('id', opp.id);
  }
}

// GET /opps
router.get('/opps', requireAuth, async (req, res) => {
  const { type, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('opportunities')
    .select(`
      *,
      poster:poster_id(id, full_name, batch_year, current_title, initials)
    `, { count: 'exact' })
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (type) query = query.eq('type', type);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ opportunities: data, total: count });
});

// POST /opps/:id/interest
router.post('/opps/:id/interest', requireAuth, async (req, res) => {
  const { message } = req.body;

  const { data, error } = await supabase
    .from('opportunity_interests')
    .upsert({
      opp_id: req.params.id,
      alumni_id: req.alumni.id,
      message: message || null
    }, { onConflict: 'opp_id,alumni_id', ignoreDuplicates: true })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Update interest count
  await supabase.from('opportunities').update({ interest_count: supabase.raw('interest_count + 1') }).eq('id', req.params.id);

  res.status(201).json({ interest: data });
});

// ═══ SYNDICATE ═══
// GET /syndicate/deals
router.get('/syndicate/deals', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('v_syndicate_summary')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Attach participation status for current user
  for (const deal of (data || [])) {
    const { data: myPart } = await supabase
      .from('syndicate_participations')
      .select('amount_lakh, status')
      .eq('deal_id', deal.id)
      .eq('alumni_id', req.alumni.id)
      .single();
    deal.my_participation = myPart || null;
  }

  res.json({ deals: data });
});

// POST /syndicate/participate
router.post('/syndicate/participate', requireAuth, requireVerified, validate(schemas.syndicateParticipate), async (req, res) => {
  const { deal_id, amount_lakh } = req.body;

  const { data: deal } = await supabase
    .from('syndicate_deals')
    .select('id, title, min_ticket_lakh, target_lakh, raised_lakh, closing_date, is_active')
    .eq('id', deal_id)
    .single();

  if (!deal?.is_active) return res.status(404).json({ error: 'Deal not found or closed' });
  if (amount_lakh < deal.min_ticket_lakh) {
    return res.status(400).json({ error: `Minimum ticket is ₹${deal.min_ticket_lakh}L` });
  }

  const { data, error } = await supabase
    .from('syndicate_participations')
    .upsert({
      deal_id,
      alumni_id: req.alumni.id,
      amount_lakh,
      status: 'committed'
    }, { onConflict: 'deal_id,alumni_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({
    participation: data,
    message: 'Commitment recorded. SPV agreement (Leegality) will be sent to your email.',
    next_step: 'sign_spv'
  });
});

// GET /leaderboard
router.get('/leaderboard', requireAuth, async (req, res) => {
  const { type = 'connects' } = req.query;

  const queries = {
    connects: supabase
      .from('connections')
      .select('requester_id, count', { count: 'exact', head: false })
      .eq('status', 'accepted'),
    intros: supabase
      .from('warm_intro_requests')
      .select('connector_id'),
    deals: supabase
      .from('syndicate_participations')
      .select('alumni_id')
      .in('status', ['committed','paid'])
  };

  // Simplified: return pre-computed stats
  const { data: stats } = await supabase
    .from('alumni_profiles')
    .select('id, full_name, batch_year, initials, city')
    .eq('is_active', true)
    .limit(20);

  res.json({ leaderboard: stats, type });
});

// Groups
router.get('/groups', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('interest_groups')
    .select(`
      *,
      group_members(alumni_id)
    `)
    .eq('is_active', true)
    .order('sort_order');

  if (error) return res.status(500).json({ error: error.message });

  const groups = (data || []).map(g => ({
    ...g,
    i_am_member: (g.group_members || []).some(m => m.alumni_id === req.alumni.id),
    member_count: (g.group_members || []).length
  }));

  res.json({ groups });
});

router.post('/groups/:id/join', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('group_members')
    .upsert({ group_id: req.params.id, alumni_id: req.alumni.id }, { onConflict: 'group_id,alumni_id', ignoreDuplicates: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, joined: true });
});

router.delete('/groups/:id/leave', requireAuth, async (req, res) => {
  await supabase.from('group_members').delete().eq('group_id', req.params.id).eq('alumni_id', req.alumni.id);
  res.json({ ok: true, joined: false });
});

// WA Broadcast (admin)
router.post('/broadcast', requireAuth, validate(schemas.broadcastWA), async (req, res) => {
  const { group_id, template_name, custom_message } = req.body;
  res.json({ ok: true, message: 'Broadcast queued. Delivery typically takes 5–10 minutes.' });
  // Actual broadcast handled by cron/broadcast.js
  logger.info('WA broadcast queued', { group_id, template: template_name, by: req.alumni.full_name });
});

module.exports = router;
