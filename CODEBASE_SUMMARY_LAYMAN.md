# Relai — Codebase Summary (Plain English)

**Version:** 0.4.1 · **Stage:** Internal trial

## What it is

Relai is a web tool that helps a clinic's staff handle the steady stream
of patient messages — questions about medication, side effects,
shipping, billing, appointments, anything. Instead of every message
landing in someone's inbox to be read and answered from scratch, staff
paste the message into Relai and an AI assistant (Claude) does a
first-pass read for them.

The AI tells staff three useful things:

1. **How urgent is this?** Is it routine, same-day, or
   stop-what-you're-doing urgent?
2. **Who should handle it?** A nurse? Billing? Shipping? Two of those?
3. **What might a reply look like?** A drafted response staff can edit,
   approve, and send.

If the AI isn't sure, it flags the message for a clinician to weigh in
on. When the clinician answers, that answer is automatically added to
Relai's knowledge base so the same question gets a better answer next
time. The system learns.

Today Relai is being used by one clinic (Big Easy Weight Loss, a
telehealth weight-loss practice). It's built so that the same tool
could be used by a totally different kind of business — another medical
practice, an auto shop, a property manager — by swapping in a different
knowledge base.

## What it can do

- **Read and sort patient messages** with an AI assistant.
- **Suggest a reply** that staff can edit and send.
- **Spot urgent stuff** and label it clearly.
- **Route non-clinical issues** (billing, shipping) to the right team.
- **Pull in messages from anywhere** — email, live chat, the clinic's
  software (Bask Health), web forms, Intercom — through pluggable
  "channels."
- **Keep a history** of every message handled, with notes on what was
  changed before sending. This is how staff (and the AI) get better.
- **Knowledge base** — a per-clinic library of policies, protocols,
  FAQs the AI consults before answering.
- **Review queue** — when the AI is uncertain, a clinician resolves it,
  and the answer becomes part of the knowledge base automatically.
- **Roles and permissions** — admins manage who can do what.
- **Secure sign-in** by emailed magic link.

## How it's built (in plain terms)

- **Front of house** (what staff see in the browser): a single web page
  written in basic HTML, CSS, and JavaScript. No fancy framework — just
  a page that loads fast and works.
- **Brains** (the AI): Anthropic's Claude — Claude Sonnet 4.6 for the
  main triage work, and the faster, cheaper Claude Haiku 4.5 for small
  rewrite tasks.
- **Back of house** (the server): a handful of small Node.js functions
  that run on Netlify. They handle saving messages, fetching the
  knowledge base, talking to Claude, and accepting webhooks from
  outside channels.
- **Storage** (the database): Supabase, which is a Postgres database
  with built-in user accounts.
- **Hosting:** Netlify — every time the code changes on the main
  branch, the site updates automatically.

## The main parts of the codebase

**What the user sees**
- `index.html` — the single page the app lives in (tabs for Inquiry and
  Knowledge Base; help and review queue in the profile menu).
- `login.html` — the sign-in page.
- `app.js` — all the page logic in one big file.
- `styles.css` — colors, layout, fonts.

**Shared data and helpers**
- `data/defaults.js` — fallback settings (brand name, AI model names).
- `data/triage-lib.js` — small helper functions used in tests.
- `data/base-prompt.js` — the instructions Claude is given before
  reading a message.
- `data/default-kb.js` — the starter knowledge base.

**The server (Netlify functions)**
- `auth.js` — sign-in, profile, sign-out.
- `kb.js` — the main back-end entry point; hands work off to smaller
  modules in `_lib/routes/` (knowledge-base edits, history, reviews,
  admin, analyze, profile).
- `triage.js` — sends a message to Claude and returns the result.
- `ingest.js` — accepts messages from outside (webhooks).
- `intercom.js`, `bask.js` — connectors for specific message channels.
- `worker.js` — a background worker for queued messages (placeholder).
- `_lib/` — shared building blocks the routes use.

**Database setup**
- `migrations/` — the SQL files that describe the database tables
  (profiles, knowledge-base entries, message history, review requests,
  audit log, API keys). Run in order on a fresh database.

**Tests and quality checks**
- `tests/` — 23 small test files (322 individual checks) that confirm
  helper functions and server routes behave correctly.
- `eval/` — a set of sample patient messages used to check that the AI
  still gives the right answers after changes.

**Background reading**
- `README.md` — setup and environment info.
- `AGENTS.md` — house rules for AI agents working on this code.
- `PLAN.md` — the long-term roadmap.
- `CHANGELOG.md` — what changed in each version.

## Where it is right now

It works. It's being used internally. The latest round of work
(versions 0.4.0–0.4.1) tidied up the server side — what used to be one
big file is now a small router that hands work off to focused modules,
and there are tests covering those routes. Next-up themes per the
roadmap: making the app comfortably multi-tenant and finishing the
pluggable-channel framework so new message sources can be added without
rewriting the core.
