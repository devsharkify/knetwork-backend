const axios = require('axios');
const logger = require('../config/logger');

const API_KEY = process.env.AUTHKEY_SMS_API_KEY || 'bedfc307ae476372';
const SID = process.env.AUTHKEY_SMS_SID || '35306';
const COMPANY = process.env.AUTHKEY_SMS_COMPANY || 'KNetwork';
const BASE_URL = 'https://api.authkey.io/request';

/**
 * Send OTP via Authkey.io SMS
 * Template: "Use {otp} as your OTP to access your {company}, OTP is confidential and valid for 5 mins"
 */
async function sendSmsOtp(mobile, otp, countryCode = '91') {
  // Clean phone — strip +91, spaces, dashes, take last 10 digits
  const cleaned = mobile.replace(/\+91|[+\s-]/g, '').trim().slice(-10);

  if (cleaned.length !== 10) {
    logger.warn('SMS OTP: invalid phone', { mobile });
    return { ok: false, error: 'Invalid phone number. Must be 10 digits.' };
  }

  try {
    const res = await axios.get(BASE_URL, {
      params: {
        authkey: API_KEY,
        mobile: cleaned,
        country_code: countryCode,
        sid: SID,
        otp,
        company: COMPANY
      },
      timeout: 30000
    });

    const data = res.data || {};

    if (res.status === 200 && /submitted/i.test(data.Message || '')) {
      logger.info('SMS OTP sent', { mobile: `****${cleaned.slice(-4)}`, logId: data.LogID });
      return { ok: true, logId: data.LogID };
    }

    logger.warn('SMS OTP failed', { mobile: `****${cleaned.slice(-4)}`, response: data });
    return { ok: false, error: data.Message || 'Failed to send OTP' };
  } catch (err) {
    logger.error('SMS OTP error', { err: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { sendSmsOtp };
