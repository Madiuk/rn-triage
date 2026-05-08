// Relai — Auth & Profile Netlify Function
// Endpoints: GET/POST /auth/profile, POST /auth/invite, POST /auth/signout

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

exports.handler = async function(event) {
  const path = event.path || '';
  const method = event.httpMethod;

  // Preflight
  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  // Headers using the user's token (respects RLS)
  const token = (event.headers.authorization || '').replace('Bearer ', '').trim();
  const userH = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + (token || SUPABASE_ANON_KEY)
  };

  // Service role headers (bypasses RLS — only for admin operations)
  const serviceH = SUPABASE_SERVICE_KEY ? {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  } : null;

  try {

    // ── GET /auth/profile ─────────────────────────────────────────────────
    if (path.includes('/profile') && method === 'GET') {
      if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };

      // Validate token and get user
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
      const user = await userRes.json();
      if (!user || !user.id) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };
      }

      // Get profile — use service key so RLS doesn't block on first login
      const hdr = serviceH || userH;
      const profRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=*,company_members(role,company_id,companies(id,name,slug,modules))`,
        { headers: hdr }
      );
      let profile = null;
      try {
        const profiles = await profRes.json();
        profile = Array.isArray(profiles) && profiles[0] ? profiles[0] : null;
      } catch(e) {}

      // If no profile exists yet, create one
      if (!profile) {
        try {
          const name = (user.user_metadata && user.user_metadata.full_name) || user.email.split('@')[0];
          await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            method: 'POST',
            headers: { ...(serviceH || userH), 'Prefer': 'return=minimal' },
            body: JSON.stringify({ id: user.id, full_name: name })
          });
        } catch(e) {}
      }

      // Update last_seen
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
          method: 'PATCH',
          headers: { ...(serviceH || userH) },
          body: JSON.stringify({ last_seen: new Date().toISOString() })
        });
      } catch(e) {}

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ user, profile })
      };
    }

    // ── POST /auth/profile — update name/role ─────────────────────────────
    if (path.includes('/profile') && method === 'POST') {
      if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
      const user = await userRes.json();
      if (!user || !user.id) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };

      const body = JSON.parse(event.body || '{}');
      const patch = {};
      if (body.full_name) patch.full_name = body.full_name;
      if (body.role) patch.role = body.role;
      patch.last_seen = new Date().toISOString();

      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
        method: 'PATCH',
        headers: { ...(serviceH || userH), 'Prefer': 'return=minimal' },
        body: JSON.stringify(patch)
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    // ── POST /auth/invite — create user + add to company ──────────────────
    if (path.includes('/invite') && method === 'POST') {
      if (!serviceH) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_SERVICE_KEY not configured' }) };
      const body = JSON.parse(event.body || '{}');
      const { email, company_id, role = 'staff' } = body;
      if (!email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email required' }) };

      // Create user via admin API
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: serviceH,
        body: JSON.stringify({
          email,
          email_confirm: true,
          user_metadata: { role, company_id: company_id || null }
        })
      });
      const newUser = await r.json();
      if (!newUser.id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: newUser.message || 'Failed to create user' }) };
      }

      // Update profile
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${newUser.id}`, {
        method: 'PATCH',
        headers: { ...serviceH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ role, company_id: company_id || null })
      });

      // Add to company_members if company provided
      if (company_id) {
        await fetch(`${SUPABASE_URL}/rest/v1/company_members`, {
          method: 'POST',
          headers: { ...serviceH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ company_id, user_id: newUser.id, role })
        });
      }

      // Send magic link so they can log in
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${newUser.id}/reauthentication`, {
        method: 'PUT',
        headers: serviceH
      });

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, user_id: newUser.id, email }) };
    }

    // ── POST /auth/signout — record last_seen ─────────────────────────────
    if (path.includes('/signout') && method === 'POST') {
      if (token) {
        try {
          const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
          const user = await userRes.json();
          if (user && user.id) {
            await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
              method: 'PATCH',
              headers: { ...(serviceH || userH) },
              body: JSON.stringify({ last_seen: new Date().toISOString() })
            });
          }
        } catch(e) {}
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };

  } catch(err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
