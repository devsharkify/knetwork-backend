const router = require('express').Router();
const supabase = require('../config/supabase');
const WA = require('../services/whatsapp');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const logger = require('../config/logger');

// GET /events
router.get('/', requireAuth, async (req, res) => {
  const { chapter, filter, upcoming, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('events')
    .select('*', { count: 'exact' })
    .eq('is_published', true)
    .order('event_date', { ascending: true })
    .range(offset, offset + parseInt(limit) - 1);

  if (chapter) query = query.eq('chapter', chapter);
  if (upcoming === 'true') query = query.gte('event_date', new Date().toISOString().split('T')[0]);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Attach RSVP status for current user
  if (data?.length) {
    const eventIds = data.map(e => e.id);
    const { data: myRsvps } = await supabase
      .from('event_rsvps')
      .select('event_id, status')
      .eq('alumni_id', req.alumni.id)
      .in('event_id', eventIds);

    const { data: myCheckins } = await supabase
      .from('event_checkins')
      .select('event_id')
      .eq('alumni_id', req.alumni.id)
      .in('event_id', eventIds);

    const rsvpMap = Object.fromEntries((myRsvps || []).map(r => [r.event_id, r.status]));
    const checkinSet = new Set((myCheckins || []).map(c => c.event_id));

    data.forEach(e => {
      e.my_rsvp = rsvpMap[e.id] || null;
      e.i_attended = checkinSet.has(e.id);
    });
  }

  res.json({ events: data, total: count });
});

// GET /events/:id — single event with attendee list
router.get('/:id', requireAuth, async (req, res) => {
  const { data: event, error } = await supabase
    .from('events')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !event) return res.status(404).json({ error: 'Event not found' });

  // People who checked in
  const { data: checkins } = await supabase
    .from('event_checkins')
    .select('alumni_profiles(id, full_name, current_title, current_company, city, initials, batch_year)')
    .eq('event_id', req.params.id);

  const attendees = (checkins || []).map(c => c.alumni_profiles);
  const iAttended = attendees.some(a => a.id === req.alumni.id);

  res.json({ event, attendees, i_attended: iAttended, attendee_count: attendees.length });
});

// POST /events/:id/checkin — self check-in
router.post('/:id/checkin', requireAuth, async (req, res) => {
  const eventId = req.params.id;

  // Check event exists and is past or today
  const { data: event } = await supabase
    .from('events')
    .select('id, title, event_date, chapter_display, is_published')
    .eq('id', eventId)
    .single();

  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (!event.is_published) return res.status(400).json({ error: 'Event not published' });

  // Allow check-in on day of event or after
  const eventDate = new Date(event.event_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (eventDate > today) {
    return res.status(400).json({ error: 'Check-in opens on the day of the event' });
  }

  // Upsert check-in
  const { error: ciErr } = await supabase
    .from('event_checkins')
    .upsert({
      event_id: eventId,
      alumni_id: req.alumni.id,
      checked_in_at: new Date().toISOString()
    }, { onConflict: 'event_id,alumni_id', ignoreDuplicates: true });

  if (ciErr) return res.status(500).json({ error: ciErr.message });

  // Get all other attendees at this event
  const { data: coAttendees } = await supabase
    .from('event_checkins')
    .select('alumni_profiles(id, full_name, current_title, current_company, batch_year, initials)')
    .eq('event_id', eventId)
    .neq('alumni_id', req.alumni.id);

  const peopleMet = (coAttendees || []).map(c => c.alumni_profiles).filter(Boolean);

  // Send WA "People you met" to this user
  if (req.alumni.wa_notifications && peopleMet.length > 0) {
    WA.peopleYouMet(req.alumni, event, peopleMet)
      .catch(e => logger.error('WA people-you-met failed', e));
  }

  // Also notify existing attendees that a new person checked in
  // (batch notify, async — don't block response)
  notifyExistingAttendees(eventId, req.alumni, event).catch(e =>
    logger.error('WA existing attendees notify failed', e)
  );

  logger.info('Event check-in', { event: event.title, alumni: req.alumni.full_name });
  res.json({
    ok: true,
    people_met: peopleMet,
    count: peopleMet.length,
    message: `Checked in! You met ${peopleMet.length} alumni at this event.`
  });
});

async function notifyExistingAttendees(eventId, newAttendee, event) {
  // Get alumni who were already checked in
  const { data: existing } = await supabase
    .from('event_checkins')
    .select('alumni_profiles(id, full_name, whatsapp_number, wa_notifications)')
    .eq('event_id', eventId)
    .neq('alumni_id', newAttendee.id);

  const toNotify = (existing || [])
    .map(c => c.alumni_profiles)
    .filter(a => a?.wa_notifications && a?.whatsapp_number);

  for (const alumnus of toNotify.slice(0, 50)) { // cap at 50 to avoid spam
    await WA.sendWA?.({
      mobile: alumnus.whatsapp_number,
      templateId: process.env.WA_TPL_PEOPLE_YOU_MET,
      variables: [alumnus.full_name, event.title, newAttendee.full_name],
      alumniId: alumnus.id
    });
    await new Promise(ok => setTimeout(ok, 500));
  }
}

// POST /events/:id/rsvp
router.post('/:id/rsvp', requireAuth, async (req, res) => {
  const { status = 'confirmed' } = req.body;

  const { data: event } = await supabase
    .from('events')
    .select('id, title, rsvp_count, capacity, ticket_price, razorpay_link')
    .eq('id', req.params.id)
    .single();

  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.rsvp_count >= event.capacity) return res.status(400).json({ error: 'Event is full' });

  const { data, error } = await supabase
    .from('event_rsvps')
    .upsert({
      event_id: req.params.id,
      alumni_id: req.alumni.id,
      status
    }, { onConflict: 'event_id,alumni_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    rsvp: data,
    payment_required: event.ticket_price > 0,
    payment_link: event.ticket_price > 0 ? event.razorpay_link : null
  });
});

// POST /events — create event (admin only)
router.post('/', requireAuth, requireAdmin(['super_admin','chapter_admin','events_manager']),
  validate(schemas.createEvent), async (req, res) => {

  const { data, error } = await supabase
    .from('events')
    .insert({ ...req.body, organizer_id: req.alumni.id, is_published: false })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ event: data });
});

// PATCH /events/:id/publish — publish + notify
router.patch('/:id/publish', requireAuth, requireAdmin(['super_admin','chapter_admin','events_manager']),
  async (req, res) => {

  const { data: event, error } = await supabase
    .from('events')
    .update({ is_published: true })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Broadcast WA to chapter alumni
  res.json({ event, message: 'Published. WhatsApp notifications sending to chapter members.' });

  // Async WA broadcast
  try {
    const { data: chapterAlumni } = await supabase
      .from('alumni_profiles')
      .select('id, full_name, whatsapp_number, wa_notifications')
      .eq('city', event.chapter)
      .eq('wa_notifications', true)
      .eq('is_active', true);

    for (const a of (chapterAlumni || [])) {
      await WA.eventReminder(a, event);
      await new Promise(ok => setTimeout(ok, 1100));
    }
  } catch (e) { logger.error('Event WA broadcast failed', e); }
});

// GET /events/:id/attendees — full attendee list with "people you met" data
router.get('/:id/attendees', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('event_checkins')
    .select(`
      checked_in_at,
      alumni_profiles(
        id, full_name, current_title, current_company, batch_year, city, initials,
        alumni_tags(interest_tags(label))
      )
    `)
    .eq('event_id', req.params.id)
    .order('checked_in_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ attendees: (data || []).map(d => d.alumni_profiles), count: data?.length });
});

module.exports = router;
