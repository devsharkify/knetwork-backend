const axios = require('axios');
const supabase = require('../config/supabase');
const logger = require('../config/logger');

const API_KEY = process.env.PROXYCURL_API_KEY;
const BASE    = 'https://nubela.co/proxycurl/api/v2';

async function scrapeProfile(linkedinUrl, alumniId) {
  const logEntry = { alumni_id: alumniId, linkedin_url: linkedinUrl, triggered_by: 'api' };

  try {
    const res = await axios.get(`${BASE}/linkedin`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      params: { url: linkedinUrl, use_cache: 'if-present' }
    });

    const p = res.data;
    const fieldsUpdated = [];

    // Build update payload
    const update = {};

    if (p.full_name)       { update.full_name = p.full_name;       fieldsUpdated.push('name'); }
    if (p.headline)        { update.bio = p.headline;               fieldsUpdated.push('bio'); }
    if (p.city)            { update.country = p.city;               fieldsUpdated.push('city'); }
    if (p.profile_pic_url) { update.photo_url = p.profile_pic_url; fieldsUpdated.push('photo'); }

    // Current role
    const exp = p.experiences?.[0];
    if (exp) {
      if (exp.title)        { update.current_title = exp.title;     fieldsUpdated.push('title'); }
      if (exp.company)      { update.current_company = exp.company; fieldsUpdated.push('company'); }
    }

    // Tags from skills
    if (p.skills?.length) {
      fieldsUpdated.push('skills');
      // Map skills → interest_tags and upsert
      await syncSkillsToTags(alumniId, p.skills.map(s => s.name || s));
    }

    update.linkedin_synced_at = new Date().toISOString();
    update.linkedin_data = p;

    // Update profile
    await supabase.from('alumni_profiles').update(update).eq('id', alumniId);

    // Log success
    await supabase.from('linkedin_sync_log').insert({
      ...logEntry,
      status: 'success',
      fields_updated: fieldsUpdated,
      credits_used: 1,
      proxycurl_cost: 0.85,
      raw_response: p
    });

    logger.info('Proxycurl sync success', { alumniId, fields: fieldsUpdated });
    return { ok: true, fieldsUpdated };

  } catch (err) {
    const status = err.response?.status === 429 ? 'rate_limited' : 'failed';
    await supabase.from('linkedin_sync_log').insert({
      ...logEntry,
      status,
      error_message: err.message
    });
    logger.error('Proxycurl sync failed', { alumniId, err: err.message });
    return { ok: false, err: err.message };
  }
}

// Map LinkedIn skill names → interest_tags
async function syncSkillsToTags(alumniId, skills) {
  const { data: tags } = await supabase
    .from('interest_tags')
    .select('id, label, slug')
    .in('category', ['industry', 'function', 'interest']);

  if (!tags) return;

  const matched = [];
  for (const skill of skills) {
    const sl = skill.toLowerCase();
    const tag = tags.find(t =>
      sl.includes(t.slug.replace(/_/g, ' ')) ||
      sl.includes(t.label.toLowerCase())
    );
    if (tag) matched.push(tag.id);
  }

  // Upsert matched tags (source = linkedin_sync)
  for (const tagId of [...new Set(matched)]) {
    await supabase.from('alumni_tags').upsert(
      { alumni_id: alumniId, tag_id: tagId, source: 'linkedin_sync' },
      { onConflict: 'alumni_id,tag_id', ignoreDuplicates: true }
    );
  }
}

// Monthly cron: sync all alumni with LinkedIn URLs
async function syncAllMonthly() {
  logger.info('Starting monthly Proxycurl sync');

  const { data: alumni } = await supabase
    .from('alumni_profiles')
    .select('id, linkedin_url, linkedin_synced_at')
    .not('linkedin_url', 'is', null)
    .eq('is_active', true);

  if (!alumni?.length) return;

  // Only sync if not synced in last 28 days
  const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const due = alumni.filter(a => !a.linkedin_synced_at || a.linkedin_synced_at < cutoff);

  logger.info(`Proxycurl: ${due.length} profiles due for sync`);

  for (const a of due) {
    await scrapeProfile(a.linkedin_url, a.id);
    await new Promise(ok => setTimeout(ok, 2000)); // 0.5 req/s
  }

  logger.info('Monthly sync complete');
}

// Detect milestone from Proxycurl diff (for achievement alerts)
function detectMilestones(prev, curr) {
  const milestones = [];
  const prevExp = prev?.experiences?.[0];
  const currExp = curr?.experiences?.[0];

  if (currExp && prevExp) {
    if (currExp.company !== prevExp.company) {
      milestones.push(`Joined ${currExp.company} as ${currExp.title}`);
    } else if (currExp.title !== prevExp.title) {
      milestones.push(`Promoted to ${currExp.title} at ${currExp.company}`);
    }
  }

  // Check for funding mentions in summary
  const summary = curr?.summary || '';
  if (/raised|series [ab]|seed round|₹|crore|million/i.test(summary) &&
      !(/raised|series [ab]|seed round|₹|crore|million/i.test(prev?.summary || ''))) {
    milestones.push('Announced a funding round');
  }

  return milestones;
}

module.exports = { scrapeProfile, syncAllMonthly, detectMilestones };
