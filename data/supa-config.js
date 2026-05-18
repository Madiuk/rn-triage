// Supabase public config (anon key is safe by design — RLS is the
// real boundary; service-key writes happen only in netlify/functions).
//
// Loaded by every page that talks to Supabase Auth directly:
//   - manual.html → app.js (silent token refresh, sign-out)
//   - index.html  → tasking.js (silent token refresh, sign-out)
//   - login.html (sign-in)
//   - accept-invite.html (set password from invite link)
//   - reset-password.html (set password from recovery link)
//
// Must load BEFORE data/auth-client.js (which reads window.RELAI_SUPA)
// and BEFORE the page's inline auth scripts.
//
// If you rotate the anon key, change it ONCE here.

window.RELAI_SUPA = {
  url: 'https://aturbsnqpdtvhrnujrqb.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0dXJic25xcGR0dmhybnVqcnFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDc5MTgsImV4cCI6MjA5MzQyMzkxOH0.l7LdmI8PfFiIXa1nIwwauiWh6KnzpwhlpK5uieATsic',
};
