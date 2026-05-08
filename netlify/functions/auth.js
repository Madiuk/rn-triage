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

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const token = (event.headers.authorization || '').replace('Bearer ', '').trim();

  const userH = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + (token || SUPABASE_ANON_KEY)
  };

  const serviceH = SUPABASE_SERVICE_KEY ? {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  } : null;

  try {

    // ── GET /auth/profile ─────────────────────────────────────────────────
    if (path.includes('/profile') && method === 'GET') {
      if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };

      // Validate token — get user from Supabase Auth
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
      const user = await userRes.json();
      if (!user || !user.id) {
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };
      }

      // Get profile — simple query, no joins (joins fail if company_members row missing)
      const hdr = serviceH || userH;
      let profile = null;
      try {
        const profRes = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=id,full_name,role,company_id,triages_completed,last_seen`,
          { headers: hdr }
        );
        const profiles = await profRes.json();
        profile = Array.isArray(profiles) && profiles.length > 0 ? profiles[0] : null;
      } catch(e) {}

      // If no profile row exists yet, create one from user metadata
      if (!profile) {
        try {
          const name = (user.user_metadata && user.user_metadata.full_name)
            || user.email.split('@')[0];
          const role = (user.user_metadata && user.user_metadata.department) || 'staff';
          const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            method: 'POST',
            headers: { ...(hdr), 'Prefer': 'return=representation' },
            body: JSON.stringify({ id: user.id, full_name: name, role: role })
          });
          const inserted = await insertRes.json();
          profile = Array.isArray(inserted) ? inserted[0] : inserted;
        } catch(e) {}
      }

      // Update last_seen silently
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
          method: 'PATCH',
          headers: { ...hdr, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ last_seen: new Date().toISOString() })
        });
      } catch(e) {}

      // Get company name separately if company_id exists
      let companyName = 'Big Easy Weight Loss';
      if (profile && profile.company_id) {
        try {
          const compRes = await fetch(
            `${SUPABASE_URL}/rest/v1/companies?id=eq.${profile.company_id}&select=name`,
            { headers: hdr }
          );
          const companies = await compRes.json();
          if (Array.isArray(companies) && companies[0]) companyName = companies[0].name;
        } catch(e) {}
      }

      // Attach company name to profile for convenience
      if (profile) profile.company_name = companyName;

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
      const patch = { last_seen: new Date().toISOString() };
      if (body.full_name) patch.full_name = body.full_name;
      if (body.role) patch.role = body.role;

      const hdr = serviceH || userH;
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
        method: 'PATCH',
        headers: { ...hdr, 'Prefer': 'return=minimal' },
        body: JSON.stringify(patch)
      });

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    // ── POST /auth/invite ─────────────────────────────────────────────────
    if (path.includes('/invite') && method === 'POST') {
      if (!serviceH) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SUPABASE_SERVICE_KEY not configured' }) };

      const body = JSON.parse(event.body || '{}');
      const { email, company_id, role = 'staff' } = body;
      if (!email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email required' }) };

      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: serviceH,
        body: JSON.stringify({ email, email_confirm: true, user_metadata: { role, company_id: company_id || null } })
      });
      const newUser = await r.json();
      if (!newUser.id) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: newUser.message || 'Failed to create user' }) };
      }

      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${newUser.id}`, {
        method: 'PATCH',
        headers: { ...serviceH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ role, company_id: company_id || null })
      });

      if (company_id) {
        await fetch(`${SUPABASE_URL}/rest/v1/company_members`, {
          method: 'POST',
          headers: { ...serviceH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ company_id, user_id: newUser.id, role })
        });
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, user_id: newUser.id, email }) };
    }

    // ── POST /auth/signout ────────────────────────────────────────────────
    if (path.includes('/signout') && method === 'POST') {
      if (token) {
        try {
          const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userH });
          const user = await userRes.json();
          if (user && user.id) {
            const hdr = serviceH || userH;
            await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
              method: 'PATCH',
              headers: { ...hdr, 'Prefer': 'return=minimal' },
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
