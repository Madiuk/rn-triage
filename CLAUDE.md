# Relai

Relai is a clinical triage SaaS that processes inbound patient messages
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

3. **Ask when unsure.** If scope or intent is ambiguous, ask. Don't guess.

4. **Slow down for two things.** The triage classification path (prompt,
   parsing, confidence gate, routing, KB retrieval) and tenant scoping.
   Everywhere else, normal speed is fine.

5. **Reviews and fixes are separate.** When asked to "find issues,"
   produce a finite scoped list. Don't start fixing during review.

---

## Non-negotiables

- No real patient content in fixtures, logs, test data, or anywhere it
  could leave the production database.
- No tenant scoping from untrusted input. Tenant identity comes from
  server-verified auth, not request bodies or query params.
- Nothing under `migrations/` without explicit confirmation in the chat.

---

## When you notice something concerning

Use the prefix `POSSIBLE SAFETY ISSUE:` at the top of your response.
This is for things you spot in passing — not requests to fix them. The
human will address them separately. Use it sparingly; it should stay
rare enough to mean something.

---

## End of instructions
