const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

if (url && key) {
  supabase = createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: 'public' }
  });
} else {
  // Stub so the server starts without Supabase configured.
  // Every call returns { data: null, error: { message: 'Supabase not configured' } }
  const notConfigured = { message: 'Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY' };
  const stub = () => ({ data: null, error: notConfigured, count: 0 });
  const chain = () => new Proxy({}, { get: () => chain });
  supabase = {
    from: () => new Proxy({}, {
      get(_, method) {
        if (['select','insert','update','upsert','delete'].includes(method)) {
          return (...args) => {
            const obj = {
              eq: () => obj, neq: () => obj, or: () => obj, in: () => obj,
              not: () => obj, gte: () => obj, lte: () => obj, lt: () => obj,
              ilike: () => obj, contains: () => obj, is: () => obj,
              order: () => obj, range: () => obj, limit: () => obj,
              single: () => Promise.resolve(stub()),
              then: (fn) => Promise.resolve(stub()).then(fn)
            };
            return obj;
          };
        }
        return () => new Proxy({}, { get: () => chain });
      }
    }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: notConfigured }),
      admin: {
        createUser: () => Promise.resolve({ data: null, error: notConfigured }),
        generateLink: () => Promise.resolve({ data: null, error: notConfigured })
      }
    },
    rpc: () => Promise.resolve({ data: null, error: notConfigured })
  };
  console.warn('⚠️  Supabase not configured — running in stub mode. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
}

module.exports = supabase;
