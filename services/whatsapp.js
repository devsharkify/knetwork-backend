const axios = require('axios');
const supabase = require('../config/supabase');
const logger = require('../config/logger');

const BASE = process.env.AUTHKEY_BASE_URL;
const KEY  = process.env.AUTHKEY_API_KEY;
const FROM = process.env.AUTHKEY_MOBILE;

// ── Core send function ──
async function sendWA({ mobile, templateId, variables = [], alumniId = null }) {
  try {
    const res = await axios.post(`${BASE}`, {
      authkey: KEY,
      mobile,
      country_code: '91',
      sid: templateId,
      msg: variables.join('|')
    });

    // Log to DB
    await supabase.from('whatsapp_log').insert({
      recipient_id: alumniId,
      phone: mobile,
      template_id: templateId,
      status: res.data?.message === 'Sent' ? 'sent' : 'failed',
      authkey_msg_id: res.data?.request_id || null
    });

    return { ok: true, data: res.data };
  } catch (err) {
    logger.error('WA send failed', { mobile, templateId, err: err.message });
    await supabase.from('whatsapp_log').insert({
      recipient_id: alumniId,
      phone: mobile,
      template_id: templateId,
      status: 'failed',
      error_msg: err.message
    });
    return { ok: false, err: err.message };
  }
}

// ── Bulk send (respects 1-per-second rate limit) ──
async function sendBulkWA(recipients, templateId, buildVariables) {
  const results = [];
  for (const r of recipients) {
    const vars = buildVariables(r);
    const res = await sendWA({ mobile: r.whatsapp_number, templateId, variables: vars, alumniId: r.id });
    results.push({ id: r.id, ...res });
    await new Promise(ok => setTimeout(ok, 1100)); // 1.1s gap
  }
  return results;
}

// ── Template helpers ──
const WA = {
  async welcome(alumni) {
    return sendWA({
      mobile: alumni.whatsapp_number,
      templateId: process.env.WA_TPL_WELCOME,
      variables: [alumni.full_name, '4812'],
      alumniId: alumni.id
    });
  },

  async otp(mobile, otp) {
    return sendWA({
      mobile,
      templateId: process.env.WA_TPL_OTP,
      variables: [otp, '10']
    });
  },

  async kmatchAlert(recipient, sender, pct) {
    return sendWA({
      mobile: recipient.whatsapp_number,
      templateId: process.env.WA_TPL_KMATCH,
      variables: [recipient.full_name, sender.full_name, `'${String(sender.batch_year).slice(2)}`, String(pct)],
      alumniId: recipient.id
    });
  },

  async oppMatch(recipient, opp) {
    return sendWA({
      mobile: recipient.whatsapp_number,
      templateId: process.env.WA_TPL_OPP_MATCH,
      variables: [recipient.full_name, opp.title, opp.poster_name],
      alumniId: recipient.id
    });
  },

  async eventReminder(recipient, event) {
    return sendWA({
      mobile: recipient.whatsapp_number,
      templateId: process.env.WA_TPL_EVENT_REMINDER,
      variables: [recipient.full_name, event.title, event.event_date, event.venue],
      alumniId: recipient.id
    });
  },

  async syndicateNew(recipient, deal) {
    return sendWA({
      mobile: recipient.whatsapp_number,
      templateId: process.env.WA_TPL_SYNDICATE_NEW,
      variables: [recipient.full_name, deal.title, deal.stage, `₹${deal.min_ticket_lakh}L`, deal.closing_date],
      alumniId: recipient.id
    });
  },

  async peopleYouMet(recipient, event, metAlumni) {
    const names = metAlumni.slice(0, 5).map(a => a.full_name).join(', ');
    return sendWA({
      mobile: recipient.whatsapp_number,
      templateId: process.env.WA_TPL_PEOPLE_YOU_MET,
      variables: [recipient.full_name, event.title, String(metAlumni.length), names],
      alumniId: recipient.id
    });
  },

  async milestone(groupMembers, alumnus, achievement) {
    return sendBulkWA(groupMembers, process.env.WA_TPL_MILESTONE, r => [
      r.full_name, alumnus.full_name, `'${String(alumnus.batch_year).slice(2)}`, achievement
    ]);
  },

  async warmIntroRequest(connector, requester, target) {
    return sendWA({
      mobile: connector.whatsapp_number,
      templateId: process.env.WA_TPL_WARM_INTRO,
      variables: [connector.full_name, requester.full_name, target.full_name],
      alumniId: connector.id
    });
  },

  async collabInterest(founder, interested) {
    return sendWA({
      mobile: founder.whatsapp_number,
      templateId: process.env.WA_TPL_COLLAB_INTEREST,
      variables: [founder.full_name, interested.full_name, `Batch '${String(interested.batch_year).slice(2)}`],
      alumniId: founder.id
    });
  },

  // Group broadcast to interest group members
  async groupBroadcast(groupId, templateId, buildVars) {
    const { data: members } = await supabase
      .from('group_members')
      .select('alumni_profiles(id, full_name, whatsapp_number, wa_notifications)')
      .eq('group_id', groupId)
      .eq('wa_alerts', true);

    const eligible = (members || [])
      .map(m => m.alumni_profiles)
      .filter(a => a?.whatsapp_number && a?.wa_notifications);

    return sendBulkWA(eligible, templateId, buildVars);
  }
};

module.exports = WA;
