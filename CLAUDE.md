# Care Station

Care Station is a clinical triage SaaS that processes inbound patient messages
using AI-assisted classification (Anthropic Claude API). Currently pre-launch,
single-tenant for Big Easy Weight Loss, being prepared for multi-tenant
deployment.

Stack: vanilla JS SPA in `app.js`, Netlify Functions (Node.js) in
`netlify/functions/`, Supabase (Postgres), Anthropic Claude Sonnet 4.6 and
Haiku 4.5.

Bugs in the triage classification path can affect patient care. The quality
bar is higher than a typical SaaS project.

---

## About the human you're working with

A registered nurse (BSN), former 911 paramedic, returning to programming
after 15 years away (last did serious work in LAMP). Clinical instincts are
sharp; modern software vocabulary is being rebuilt.

When you use jargon or idioms a current developer would recognize but a
returning one might not (e.g. "smoke test," "happy path," "fan-out"), add a
short "GLOSSARY NOTES" section at the end of your response defining them.
Be selective — only flag terms with specific technical meaning, not basic
ones like "function" or "variable."

---

## Principles

1. **Describe before changing.** Propose what you'll change before editing.
   Wait for confirmation.

2. **Stay narrow.** Do what was asked. If you notice other things worth
   doing, mention them in one sentence at the end — don't fix them.

   The three-file limit is a heuristic, not an absolute. What matters is
   whether the change touches one logical concern. A function and its
   directly associated test count as one concern. Generated files (types,
   etc.) don't count toward the limit. Migrations always count and always
   trigger the clinical-sensitive flag regardless.

3. **Ask when unsure.** If scope or intent is ambiguous, ask. Don't guess.

4. **Slow down for two things.** The triage classification path (prompt,
   parsing, confidence gate, routing, KB retrieval) and tenant scoping.
   Everywhere else, normal speed is fine.

   For behavior changes in the triage path, verify a test pins down the
   current behavior before refactoring; if there isn't one, propose the
   test first. Renames, log additions, and behavior-preserving refactors
   in the triage path don't require a pinning test, but they still require
   explicit description and confirmation before editing.

   When you're about to touch the triage path or anything under
   `migrations/`, open your response with `CLINICAL-SENSITIVE:` so it
   stands out in scrollback.

5. **Reviews and fixes are separate.** When asked to "find issues,"
   produce a finite scoped list. Don't start fixing during review.

---

## Tenant scoping

The codebase is currently single-tenant but multi-tenant is the target.
Write all new code as if multi-tenant exists. Tenant ID comes from
server-verified auth context, never from request input (body, query
params, headers controllable by the client). Existing single-tenant code
that doesn't follow this is not for you to fix in passing — note it and
move on.

---

## Non-negotiables

- No real patient content in fixtures, logs, test data, or anywhere it
  could leave the production database.
- No tenant scoping from untrusted input. Tenant identity comes from
  server-verified auth, not request bodies or query params.
- Nothing under `migrations/` without explicit confirmation in the chat.
- If Claude's classification response is malformed, missing required
  fields, or fails validation, the message routes to human review and
  the failure is logged. Never let a bad response flow through to
  automated routing.
- API keys, tokens, and credentials live in environment variables,
  never in source files.
- Don't modify a test to make it pass after a code change. A failing
  test is information, not an obstacle.

---

## When you notice something concerning

Use the prefix `POSSIBLE SAFETY ISSUE:` at the top of your response.
This is for things you spot in passing — not requests to fix them. The
human will address them separately. Use it sparingly; it should stay
rare enough to mean something.

---

## End of instructions
