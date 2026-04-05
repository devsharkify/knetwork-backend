const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../config/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-20250514';

// ── Feed post moderation ──
async function moderatePost(postBody, authorBatch, postType) {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: `You are a content moderator for K·Network — an exclusive alumni platform for IIM Kozhikode graduates (top business school in India). 
Posts should be: professional, relevant to the alumni community, constructive.
Reject posts that are: spam, promotional without value, offensive, politically inflammatory, personal attacks, or completely off-topic.
Respond ONLY with valid JSON, no other text.`,
      messages: [{
        role: 'user',
        content: `Moderate this ${postType} post by a Batch '${String(authorBatch).slice(2)} alumnus:\n\n"${postBody}"\n\nRespond: {"approved":true/false,"reason":"brief reason","severity":"none/low/medium/high","suggested_edit":"optional improved version or null"}`
      }]
    });

    const text = res.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    logger.error('Claude moderation failed', { err: err.message });
    return { approved: true, reason: 'Moderation unavailable — auto-approved', severity: 'none' };
  }
}

// ── K-Match score explanation ──
async function explainMatch(alumniA, alumniB, score) {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: 'You write concise, warm 1-sentence explanations of why two IIMK alumni would benefit from connecting. Keep it under 20 words.',
      messages: [{
        role: 'user',
        content: `Why should ${alumniA.full_name} (${alumniA.current_title}, goals: ${alumniA.goals?.join(', ')}) connect with ${alumniB.full_name} (${alumniB.current_title}, goals: ${alumniB.goals?.join(', ')})? Match score: ${score}%.`
      }]
    });
    return res.content[0].text.trim();
  } catch (err) {
    return `${score}% compatibility based on shared interests and goals.`;
  }
}

// ── Lead scoring for opportunities ──
async function scoreOpportunity(opp, alumniProfile) {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 128,
      system: 'Score how relevant an opportunity is for an alumni profile. Respond ONLY with JSON.',
      messages: [{
        role: 'user',
        content: `Opportunity: "${opp.title}" (${opp.type}) at ${opp.company || 'N/A'}.
Alumni: ${alumniProfile.current_title} at ${alumniProfile.current_company}, tags: ${alumniProfile.tags?.join(', ')}, goals: ${alumniProfile.goals?.join(', ')}.
Respond: {"score":0-100,"reason":"one sentence","notify":true/false}`
      }]
    });
    const text = res.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    return { score: 50, reason: 'Scoring unavailable', notify: true };
  }
}

// ── Achievement post generation ──
async function generateAchievementPost(alumnus, achievement) {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 150,
      system: 'Write a warm, congratulatory feed post for an IIMK alumni milestone. Keep it under 40 words, professional, celebratory. No hashtags.',
      messages: [{
        role: 'user',
        content: `Alumnus: ${alumnus.full_name}, Batch '${String(alumnus.batch_year).slice(2)}, currently ${alumnus.current_title} at ${alumnus.current_company}. Achievement: ${achievement}. Write the post.`
      }]
    });
    return res.content[0].text.trim();
  } catch (err) {
    return `🎉 Congratulations to ${alumnus.full_name} (Batch '${String(alumnus.batch_year).slice(2)}) on ${achievement}!`;
  }
}

// ── Warm intro message draft ──
async function draftIntroMessage(requester, target, connector) {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: 'Draft a warm, brief introduction request message from one IIMK alumni to another. Professional but warm. Under 50 words.',
      messages: [{
        role: 'user',
        content: `${requester.full_name} (${requester.current_title}) wants an intro to ${target.full_name} (${target.current_title}) via ${connector.full_name}. Draft the WhatsApp message ${requester.full_name} would send to ${connector.full_name}.`
      }]
    });
    return res.content[0].text.trim();
  } catch (err) {
    return `Hi ${connector.full_name.split(' ')[0]}! Could you introduce me to ${target.full_name}? Would love to connect. — ${requester.full_name}`;
  }
}

module.exports = { moderatePost, explainMatch, scoreOpportunity, generateAchievementPost, draftIntroMessage };
