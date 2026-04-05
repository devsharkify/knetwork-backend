const router = require('express').Router();
const supabase = require('../config/supabase');
const WA = require('../services/whatsapp');
const { explainMatch } = require('../services/claude');
const { requireAuth, requireVerified, requireAdmin } = require('../middleware/auth');
const logger = require('../config/logger');

// GET /kmatch/feed — personalised match suggestions
router.get('/feed', requireAuth, requireVerified, async (req, res) => {
  const { filter, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('kmatch_scores')
    .select(`
      score_total, score_industry, score_intent, score_function,
      score_batch, score_city, common_tags, computed_at,
      match:alumni_b_id(
        id, full_name, current_title, current_company, batch_year,
        city, photo_url, initials, kmatch_active, is_verified,
        alumni_tags(interest_tags(label, category)),
        alumni_goals(goal)
      )
    `, { count: 'exact' })
    .eq('alumni_a_id', req.alumni.id)
    .eq('match.kmatch_active', true)
    .eq('match.is_active', true)
    .order('score_total', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  // Filter by type
  if (filter === 'investor')   query = query.contains('match.alumni_goals', [{ goal: 'invest' }]);
  if (filter === 'founder')    query = query.contains('match.alumni_goals', [{ goal: 'raise_funding' }]);
  if (filter === 'batch') {
    const batchMin = req.alumni.batch_year - 4;
    const batchMax = req.alumni.batch_year + 4;
    query = query.gte('match.batch_year', batchMin).lte('match.batch_year', batchMax);
  }

  // Exclude already actioned
  const { data: actioned } = await supabase
    .from('kmatch_actions')
    .select('target_id')
    .eq('actor_id', req.alumni.id);

  const actionedIds = (actioned || []).map(a => a.target_id);
  if (actionedIds.length) query = query.not('alumni_b_id', 'in', `(${actionedIds.join(',')})`);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Add Claude explanation for top 3
  const enriched = await Promise.all((data || []).slice(0, 3).map(async m => {
    const explanation = await explainMatch(req.alumni, m.match, m.score_total);
    return { ...m, explanation };
  }));

  const rest = (data || []).slice(3);
  res.json({ matches: [...enriched, ...rest], total: count });
});

// POST /kmatch/action — swipe connect or skip
router.post('/action', requireAuth, requireVerified, async (req, res) => {
  const { target_id, action } = req.body;

  if (!['connect', 'skip', 'superconnect'].includes(action)) {
    return res.status(400).json({ error: 'Action must be connect, skip, or superconnect' });
  }

  if (target_id === req.alumni.id) return res.status(400).json({ error: 'Cannot action yourself' });

  // Record action
  await supabase.from('kmatch_actions').upsert(
    { actor_id: req.alumni.id, target_id, action },
    { onConflict: 'actor_id,target_id' }
  );

  if (action === 'connect' || action === 'superconnect') {
    // Create connection request
    const { data: conn } = await supabase.from('connections').upsert({
      requester_id: req.alumni.id,
      recipient_id: target_id,
      status: 'pending'
    }, { onConflict: 'requester_id,recipient_id', ignoreDuplicates: true }).select().single();

    // Get target for WA
    const { data: target } = await supabase
      .from('alumni_profiles')
      .select('id, full_name, whatsapp_number, wa_notifications, batch_year')
      .eq('id', target_id)
      .single();

    // K-Match score for the WA message
    const { data: score } = await supabase
      .from('kmatch_scores')
      .select('score_total')
      .or(`and(alumni_a_id.eq.${req.alumni.id},alumni_b_id.eq.${target_id}),and(alumni_a_id.eq.${target_id},alumni_b_id.eq.${req.alumni.id})`)
      .single();

    if (target?.wa_notifications) {
      WA.kmatchAlert(target, req.alumni, score?.score_total || 80)
        .catch(e => logger.error('WA kmatch alert failed', e));
    }

    // Check if mutual (target also connected to requester)
    const { data: mutual } = await supabase
      .from('kmatch_actions')
      .select('id')
      .eq('actor_id', target_id)
      .eq('target_id', req.alumni.id)
      .eq('action', 'connect')
      .single();

    if (mutual) {
      // Auto-accept both sides
      await supabase.from('connections')
        .update({ status: 'accepted', connected_at: new Date().toISOString() })
        .or(`and(requester_id.eq.${req.alumni.id},recipient_id.eq.${target_id}),and(requester_id.eq.${target_id},recipient_id.eq.${req.alumni.id})`);
    }

    return res.json({ ok: true, action, mutual: !!mutual });
  }

  res.json({ ok: true, action });
});

// POST /kmatch/recompute — admin trigger to recompute all scores
router.post('/recompute', requireAuth, requireAdmin(['super_admin']), async (req, res) => {
  res.json({ ok: true, message: 'Score recomputation queued (runs via cron)' });
  // Actual recomputation happens in cron/kmatch.js
});

module.exports = router;
