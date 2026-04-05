const supabase = require('../config/supabase');
const logger = require('../config/logger');

// Verify Supabase JWT and attach alumni profile to req
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = header.slice(7);

  try {
    // Verify with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

    // Fetch alumni profile
    const { data: profile, error: profileErr } = await supabase
      .from('alumni_profiles')
      .select(`
        *,
        alumni_tags(tag_id, interest_tags(label, category)),
        alumni_goals(goal)
      `)
      .eq('user_id', user.id)
      .single();

    if (profileErr || !profile) {
      return res.status(403).json({ error: 'Alumni profile not found' });
    }

    if (!profile.is_active) {
      return res.status(403).json({ error: 'Account suspended' });
    }

    req.user = user;
    req.alumni = profile;
    next();
  } catch (err) {
    logger.error('Auth middleware error', { err: err.message });
    return res.status(500).json({ error: 'Authentication error' });
  }
}

// Check if alumni is verified before accessing sensitive features
function requireVerified(req, res, next) {
  if (!req.alumni?.is_verified) {
    return res.status(403).json({
      error: 'Profile not verified',
      message: 'Complete verification to access K-Match, Syndicate, and other premium features.',
      action: 'verify'
    });
  }
  next();
}

// Admin role check (for admin dashboard)
function requireAdmin(roles = []) {
  return async (req, res, next) => {
    const { data: admin } = await supabase
      .from('admin_users')
      .select('role, chapter_city')
      .eq('alumni_id', req.alumni.id)
      .eq('is_active', true)
      .single();

    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    if (roles.length && !roles.includes(admin.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }

    // Chapter admin city scope
    if (admin.role === 'chapter_admin' && admin.chapter_city) {
      req.chapterCity = admin.chapter_city;
    }

    req.adminRole = admin.role;
    next();
  };
}

module.exports = { requireAuth, requireVerified, requireAdmin };
