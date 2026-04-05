const cron = require('node-cron');
const supabase = require('../config/supabase');
const { syncAllMonthly, scrapeProfile, detectMilestones } = require('../services/proxycurl');
const WA = require('../services/whatsapp');
const { generateAchievementPost } = require('../services/claude');
const logger = require('../config/logger');

function startCrons() {
  logger.info('Starting cron jobs');

  // ── 1. Monthly LinkedIn sync — 1st of month, 3 AM IST ──
  cron.schedule('0 21 * * *', async () => { // 21:30 UTC = 3 AM IST
    const today = new Date().getDate();
    if (today === 1) {
      logger.info('CRON: Monthly Proxycurl sync starting');
      await syncAllMonthly();
    }
  }, { timezone: 'UTC' });

  // ── 2. Achievement detector — daily 4 AM IST ──
  cron.schedule('0 22 * * *', async () => {
    logger.info('CRON: Achievement detection run');

    const { data: recent } = await supabase
      .from('linkedin_sync_log')
      .select('alumni_id, raw_response, synced_at')
      .eq('status', 'success')
      .gte('synced_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('synced_at', { ascending: false });

    for (const log of (recent || [])) {
      try {
        const { data: prev } = await supabase
          .from('linkedin_sync_log')
          .select('raw_response')
          .eq('alumni_id', log.alumni_id)
          .eq('status', 'success')
          .lt('synced_at', log.synced_at)
          .order('synced_at', { ascending: false })
          .limit(1)
          .single();

        if (!prev?.raw_response) continue;

        const milestones = detectMilestones(prev.raw_response, log.raw_response);
        if (!milestones.length) continue;

        const { data: alumnus } = await supabase
          .from('alumni_profiles')
          .select('id, full_name, batch_year, current_title, current_company')
          .eq('id', log.alumni_id)
          .single();

        for (const achievement of milestones) {
          // Generate post with Claude
          const postBody = await generateAchievementPost(alumnus, achievement);

          // Create feed post
          await supabase.from('feed_posts').insert({
            author_id: null, // system post
            post_type: 'announcement',
            body: postBody,
            visibility: 'all_alumni',
            moderation_status: 'approved'
          });

          // WA milestone alert to interest groups
          const { data: groups } = await supabase.from('interest_groups').select('id').limit(3);
          for (const g of (groups || [])) {
            await WA.groupBroadcast(g.id, process.env.WA_TPL_MILESTONE, r => [
              r.full_name, alumnus.full_name, `'${String(alumnus.batch_year).slice(2)}`, achievement
            ]);
          }

          logger.info('Achievement detected and posted', { alumni: alumnus.full_name, achievement });
        }
      } catch (e) {
        logger.error('Achievement detection error', { alumni_id: log.alumni_id, err: e.message });
      }
    }
  }, { timezone: 'UTC' });

  // ── 3. K-Match score recomputation — nightly 2 AM IST ──
  cron.schedule('0 20 * * *', async () => {
    logger.info('CRON: K-Match score recomputation');

    const { data: alumni } = await supabase
      .from('alumni_profiles')
      .select('id')
      .eq('is_active', true)
      .eq('kmatch_active', true)
      .limit(500);

    if (!alumni?.length) return;

    let computed = 0;
    for (const a of alumni) {
      for (const b of alumni) {
        if (a.id >= b.id) continue; // avoid duplicates

        const { data: score } = await supabase.rpc('compute_kmatch_score', {
          p_alumni_a: a.id,
          p_alumni_b: b.id
        });

        if (score > 40) { // only store meaningful scores
          await supabase.from('kmatch_scores').upsert({
            alumni_a_id: a.id,
            alumni_b_id: b.id,
            score_total: score,
            computed_at: new Date().toISOString()
          }, { onConflict: 'alumni_a_id,alumni_b_id' });
          computed++;
        }

        // Throttle to avoid DB overload
        if (computed % 100 === 0) await new Promise(ok => setTimeout(ok, 500));
      }
    }

    logger.info(`K-Match: ${computed} scores computed`);
  }, { timezone: 'UTC' });

  // ── 4. Event reminders — daily 9 AM IST ──
  cron.schedule('0 3 * * *', async () => {
    logger.info('CRON: Event reminders');

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const in7Days = new Date();
    in7Days.setDate(in7Days.getDate() + 7);
    const in7Str = in7Days.toISOString().split('T')[0];

    const in30Days = new Date();
    in30Days.setDate(in30Days.getDate() + 30);
    const in30Str = in30Days.toISOString().split('T')[0];

    const dates = [tomorrowStr, in7Str, in30Str];

    for (const dateStr of dates) {
      const { data: events } = await supabase
        .from('events')
        .select('id, title, event_date, venue, chapter')
        .eq('event_date', dateStr)
        .eq('is_published', true);

      for (const event of (events || [])) {
        const { data: rsvps } = await supabase
          .from('event_rsvps')
          .select('alumni_profiles(id, full_name, whatsapp_number, wa_notifications)')
          .eq('event_id', event.id)
          .eq('status', 'confirmed');

        for (const r of (rsvps || [])) {
          const a = r.alumni_profiles;
          if (a?.wa_notifications) {
            await WA.eventReminder(a, event);
            await new Promise(ok => setTimeout(ok, 1100));
          }
        }
      }
    }
  }, { timezone: 'UTC' });

  // ── 5. Weekly digest — Sundays 8 AM IST ──
  cron.schedule('0 2 * * 0', async () => {
    logger.info('CRON: Weekly digest');

    const { data: alumni } = await supabase
      .from('alumni_profiles')
      .select('id, full_name, whatsapp_number, email_digest, wa_notifications, batch_year')
      .eq('is_active', true)
      .eq('email_digest', true)
      .limit(1000);

    // Digest stats
    const { count: newAlumni } = await supabase
      .from('alumni_profiles')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    const { count: newOpps } = await supabase
      .from('opportunities')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    logger.info(`Weekly digest: ${alumni?.length} recipients, ${newAlumni} new alumni, ${newOpps} new opps`);
    // In production: send email digest via SendGrid / Resend
  }, { timezone: 'UTC' });

  // ── 6. Expired opportunities cleanup — daily midnight IST ──
  cron.schedule('0 18 * * *', async () => {
    await supabase
      .from('opportunities')
      .update({ is_active: false })
      .lt('expires_at', new Date().toISOString())
      .eq('is_active', true);
    logger.info('CRON: Expired opportunities cleaned up');
  }, { timezone: 'UTC' });

  logger.info('All cron jobs scheduled');
}

module.exports = { startCrons };
