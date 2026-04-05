const router = require('express').Router();
const supabase = require('../config/supabase');
const WA = require('../services/whatsapp');
const { sendSmsOtp } = require('../services/sms');
const { scrapeProfile } = require('../services/proxycurl');
const { validate, schemas } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const logger = require('../config/logger');

// In-memory OTP store (use Redis in production)
const otpStore = new Map();

// POST /auth/send-otp
router.post('/send-otp', async (req, res) => {
  const { mobile, country_code = '+91' } = req.body;
  if (!mobile || !/^\d{8,15}$/.test(mobile)) {
    return res.status(400).json({ error: 'Invalid mobile number' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const key = `${country_code}${mobile}`;
  otpStore.set(key, { otp, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });

  // Send OTP via SMS (Authkey.io)
  const smsResult = await sendSmsOtp(mobile, otp, country_code.replace('+', ''));

  if (!smsResult.ok) {
    logger.warn('SMS OTP failed, falling back to WhatsApp', { mobile: mobile.slice(-4).padStart(mobile.length, '*') });
    await WA.otp(mobile, otp);
    return res.json({ ok: true, message: 'OTP sent via WhatsApp', channel: 'whatsapp' });
  }

  logger.info('OTP sent via SMS', { mobile: mobile.slice(-4).padStart(mobile.length, '*') });
  res.json({ ok: true, message: 'OTP sent via SMS', channel: 'sms', expires_in: 300 });
});

// POST /auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  const { mobile, country_code = '+91', otp } = req.body;
  const key = `${country_code}${mobile}`;
  const stored = otpStore.get(key);

  if (!stored) return res.status(400).json({ error: 'OTP not found or expired. Request a new one.' });
  if (Date.now() > stored.expires) { otpStore.delete(key); return res.status(400).json({ error: 'OTP expired' }); }
  if (stored.attempts >= 3) { otpStore.delete(key); return res.status(400).json({ error: 'Too many attempts. Request a new OTP.' }); }
  if (stored.otp !== otp) {
    stored.attempts = (stored.attempts || 0) + 1;
    const remaining = 3 - stored.attempts;
    return res.status(400).json({ error: `Incorrect OTP. ${remaining} attempts remaining.` });
  }

  otpStore.delete(key);

  // Check if alumni already registered
  const phone = `${country_code}${mobile}`;
  const { data: existing } = await supabase
    .from('alumni_profiles')
    .select('id, user_id, full_name, is_verified')
    .eq('whatsapp_number', mobile)
    .single();

  if (existing) {
    // Sign in: create Supabase session
    const { data: session, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: existing.personal_email || `${mobile}@knetwork.alumni`,
      options: { redirectTo: process.env.FRONTEND_URL }
    });

    return res.json({ ok: true, status: 'existing', alumni_id: existing.id, session });
  }

  // New user — return verified token to complete registration
  res.json({ ok: true, status: 'new', verified_mobile: phone });
});

// POST /auth/register
router.post('/register', validate(schemas.register), async (req, res) => {
  const { full_name, batch_year, program, personal_email, whatsapp_number,
          whatsapp_country_code, city, linkedin_url, goals, tag_ids, group_ids, roll_number } = req.body;

  // Create Supabase auth user
  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email: personal_email,
    email_confirm: true,
    user_metadata: { full_name, batch_year }
  });

  if (authErr) {
    logger.error('Auth user creation failed', { email: personal_email, err: authErr.message });
    return res.status(400).json({ error: authErr.message });
  }

  // Create alumni profile
  const { data: profile, error: profileErr } = await supabase
    .from('alumni_profiles')
    .insert({
      user_id: authUser.user.id,
      full_name,
      batch_year,
      program,
      personal_email,
      whatsapp_number,
      whatsapp_country_code,
      city,
      linkedin_url: linkedin_url || null,
      roll_number: roll_number || null,
      profile_completion: calculateCompletion({ full_name, batch_year, linkedin_url, goals, tag_ids }),
      is_verified: false // needs admin verification or roll number check
    })
    .select()
    .single();

  if (profileErr) {
    logger.error('Profile creation failed', { err: profileErr.message });
    return res.status(500).json({ error: 'Failed to create profile' });
  }

  // Add goals
  if (goals?.length) {
    await supabase.from('alumni_goals').insert(
      goals.map(g => ({ alumni_id: profile.id, goal: g }))
    );
  }

  // Add tags
  if (tag_ids?.length) {
    await supabase.from('alumni_tags').insert(
      tag_ids.map(t => ({ alumni_id: profile.id, tag_id: t }))
    );
  }

  // Join groups
  if (group_ids?.length) {
    await supabase.from('group_members').insert(
      group_ids.map(g => ({ alumni_id: profile.id, group_id: g }))
    );
  }

  // Trigger LinkedIn sync async
  if (linkedin_url) {
    scrapeProfile(linkedin_url, profile.id).catch(e => logger.error('LinkedIn sync error', e));
  }

  // Send welcome WA
  WA.welcome({ ...profile, whatsapp_number }).catch(e => logger.error('WA welcome failed', e));

  // Generate session
  const { data: session } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: personal_email
  });

  logger.info('New alumni registered', { name: full_name, batch: batch_year, city });
  res.status(201).json({ ok: true, alumni: profile, session });
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ alumni: req.alumni });
});

function calculateCompletion(data) {
  let score = 20; // base
  if (data.full_name) score += 15;
  if (data.batch_year) score += 10;
  if (data.linkedin_url) score += 20;
  if (data.goals?.length) score += 15;
  if (data.tag_ids?.length >= 3) score += 20;
  return Math.min(score, 100);
}

module.exports = router;
