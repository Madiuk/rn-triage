// Relai Auth & Profile functions
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // needs service role key
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

exports.handler = async function(event) {
  const path = event.path || '';
  const method = event.httpMethod;
  const h = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
  };
  const serviceH = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
  };

  // ── GET /auth/profile — fetch current user's profile + company ──────────
  if (path.includes('/profile') && method === 'GET') {
    const token = (event.headers.authorization || '').replace('Bearer ', '');
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    // Get user from token
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { ...h, 'Authorization': 'Bearer ' + token }
    });
    const user = await userRes.json();
    if (!user.id) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    // Get profile + company membership
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=*,company_members(role,company_id,companies(id,name,slug,modules))`,
      { headers: { ...h, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=representation' } }
    );
    const profiles = await profRes.json();
    const profile = Array.isArray(profiles) && profiles[0] ? profiles[0] : null;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, profile })
    };
  }

  // ── POST /auth/profile — update profile ──────────────────────────────────
  if (path.includes('/profile') && method === 'POST') {
    const token = (event.headers.authorization || '').replace('Bearer ', '');
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    const body = JSON.parse(event.body || '{}');
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { ...h, 'Authorization': 'Bearer ' + token }
    });
    const user = await userRes.json();
    if (!user.id) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      headers: { ...h, 'Authorization': 'Bearer ' + token, 'Prefer': 'return=representation' },
      body: JSON.stringify({ full_name: body.full_name, role: body.role, last_seen: new Date().toISOString() })
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: await r.text() };
  }

  // ── POST /auth/invite — generate magic link invite (admin only) ──────────
  if (path.includes('/invite') && method === 'POST') {
    if (!SUPABASE_SERVICE_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Service key not configured' }) };
    const body = JSON.parse(event.body || '{}');
    const { email, company_id, role } = body;
    if (!email || !company_id) return { statusCode: 400, body: JSON.stringify({ error: 'email and company_id required' }) };
    // Generate magic link via Supabase admin API
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { ...serviceH },
      body: JSON.stringify({
        email,
        email_confirm: true,
        user_metadata: { company_id, role: role || 'staff' }
      })
    });
    const newUser = await r.json();
    if (newUser.id) {
      // Add to company_members
      await fetch(`${SUPABASE_URL}/rest/v1/company_members`, {
        method: 'POST',
        headers: { ...serviceH, 'Prefer': 'return=representation' },
        body: JSON.stringify({ company_id, user_id: newUser.id, role: role || 'staff' })
      });
      // Update profile with company
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${newUser.id}`, {
        method: 'PATCH',
        headers: { ...serviceH },
        body: JSON.stringify({ company_id, role: role || 'staff' })
      });
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, user: newUser }) };
  }

  // ── POST /auth/signout — record last_seen ────────────────────────────────
  if (path.includes('/signout') && method === 'POST') {
    const token = (event.headers.authorization || '').replace('Bearer ', '');
    if (token) {
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { ...h, 'Authorization': 'Bearer ' + token }
      });
      const user = await userRes.json();
      if (user.id) {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
          method: 'PATCH',
          headers: { ...h, 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ last_seen: new Date().toISOString() })
        });
      }
    }
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
};
