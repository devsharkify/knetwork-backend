require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const logger = require('./config/logger');
const { startCrons } = require('./cron/index');

const app = express();

// ── Security & middleware ──
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: m => logger.info(m.trim()) } }));

// ── Rate limiting ──
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use('/api/', limiter);

// Stricter limit on OTP endpoint
const otpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,
  message: { error: 'Too many OTP requests. Wait 1 minute.' }
});
app.use('/api/auth/send-otp', otpLimiter);

// ── Routes ──
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/alumni',    require('./routes/alumni'));
app.use('/api/kmatch',    require('./routes/kmatch'));
app.use('/api/events',    require('./routes/events'));
app.use('/api',           require('./routes/feed'));   // /api/feed, /api/opps, /api/syndicate, /api/groups, /api/leaderboard, /api/broadcast

// ── Webhooks (no auth middleware — verified by signature) ──
app.post('/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  const crypto = require('crypto');
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('hex');

  if (digest !== signature) {
    logger.warn('Invalid Razorpay webhook signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(req.body);
  const event = payload.event;

  if (event === 'payment.captured') {
    const { order_id, amount, notes } = payload.payload.payment.entity;
    const supabase = require('./config/supabase');

    // Update syndicate participation to paid
    if (notes?.deal_id && notes?.alumni_id) {
      await supabase.from('syndicate_participations')
        .update({ status: 'paid', razorpay_order_id: order_id })
        .eq('deal_id', notes.deal_id)
        .eq('alumni_id', notes.alumni_id);
      logger.info('Syndicate payment confirmed', { order_id, amount: amount / 100 });
    }

    // Update event RSVP to paid
    if (notes?.event_id && notes?.alumni_id) {
      await supabase.from('event_rsvps')
        .update({ payment_status: 'paid', razorpay_order_id: order_id })
        .eq('event_id', notes.event_id)
        .eq('alumni_id', notes.alumni_id);
    }
  }

  if (event === 'payment.failed') {
    logger.warn('Payment failed', payload.payload.payment.entity.order_id);
  }

  res.json({ ok: true });
});

app.post('/webhooks/leegality', express.json(), async (req, res) => {
  const { document_id, status, signer_email } = req.body;
  const supabase = require('./config/supabase');

  if (status === 'completed') {
    await supabase.from('syndicate_participations')
      .update({ spv_signed: true, leegality_doc_id: document_id })
      .eq('leegality_doc_id', document_id);
    logger.info('Leegality e-sign completed', { document_id });
  }

  res.json({ ok: true });
});

// ── Health check ──
app.get('/health', async (req, res) => {
  const supabase = require('./config/supabase');
  let dbOk = false;
  try {
    const { error } = await supabase.from('alumni_profiles').select('id').limit(1);
    dbOk = !error;
  } catch {}

  res.json({
    status: dbOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    services: {
      database: dbOk ? 'connected' : 'error',
      whatsapp: !!process.env.AUTHKEY_API_KEY ? 'configured' : 'missing',
      proxycurl: !!process.env.PROXYCURL_API_KEY ? 'configured' : 'missing',
      claude: !!process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing',
      razorpay: !!process.env.RAZORPAY_KEY_ID ? 'configured' : 'missing'
    }
  });
});

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { err: err.message, stack: err.stack, path: req.path });
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`K·Network API running on port ${PORT} [${process.env.NODE_ENV}]`);

  if (process.env.NODE_ENV === 'production') {
    startCrons();
    logger.info('Cron jobs active');
  }
});

module.exports = app;
