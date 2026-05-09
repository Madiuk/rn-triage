# AGENTS.md — Rules for AI agents working on this repo

This file is read by Claude Code (and any other AI coding assistant) at the
start of each session. Every change to this codebase must follow these rules.
If a rule prevents an action, ask the user before bypassing it.

---

## Project shape

- **Relai** is a clinical triage tool: staff paste a patient message, an
  Anthropic Claude model classifies it against a per-tenant Knowledge Base
  and returns a structured JSON triage decision. Currently single-tenant
  (Big Easy Weight Loss); architected to become a multi-tenant SaaS.
- **Stack:** vanilla HTML/CSS/JS frontend, Netlify Functions (Node) backend,
  Supabase for auth/DB/RLS, Anthropic API for triage and correction analysis.
- **Deploy:** Netlify auto-deploys `main`. There is no build step today —
  files are served directly. Don't introduce a build dependency without
  explicit user approval.

---

## File map

```
/                          repo root
├── index.html             single-page app shell + tabs
├── login.html             magic-link auth landing
├── app.js                 monolithic SPA logic (modular split deferred)
├── styles.css             all visual styles, class-based
├── data/
│   ├── base-prompt.js     BASE_PROMPT (loaded as global before app.js)
│   ├── default-kb.js      DEFAULT_KB (loaded as global before app.js)
│   └── defaults.js        single source for fallback constants (company name,
│                          model IDs, etc.) — never hardcode these elsewhere
├── netlify/
│   ├── functions/
│   │   ├── auth.js        profile, invite, signout
│   │   ├── kb.js          KB CRUD, history, reviews, /analyze proxy
│   │   ├── triage.js      Anthropic /v1/messages proxy with model allowlist
│   │   ├── ingest.js      EHR webhook intake (idempotent by external_id)
│   │   ├── worker.js      background processor for pending ingests (stub)
│   │   └── bask.js        outbound to Bask EHR (stub)
│   └── (netlify.toml)
├── migrations/            SQL files — single source of truth for DB schema.
│                          Run in numeric order. New schema changes = new file.
├── tests/                 plain-Node unit tests (no framework). `npm test`.
├── eval/                  eval harness skeleton (eval cases for regression
│                          testing of triage outputs)
├── AGENTS.md              this file
├── PLAN.md                strategic roadmap
└── README.md              human-facing project doc
```

---

## Hard rules (do not violate)

1. **Never delete a function or DB column without searching for callers
   first.** Use `grep -rn "<name>"` across the repo. If the symbol is
   referenced anywhere — including comments, SQL, HTML attributes — check
   with the user before removing.

2. **Never silently swallow errors.** No `} catch(e) {}` blocks. At
   minimum: `console.error('<context>:', e.message)`. Better: surface to
   the user via a toast or status indicator.

3. **Never hardcode tenant-specific values** in `app.js`, `index.html`, or
   any function. Company name, theme colors, allowed categories, model
   names — all come from `data/defaults.js` (fallback) or the `tenants`
   table (when populated). One source per value.

4. **Never introduce a build step or new framework dependency** without
   user approval. The site must keep deploying as static files + Netlify
   functions until the user explicitly opts in to bundling.

5. **Never change the public API contract** of a Netlify function (path,
   request body shape, response shape) without versioning. Add a new
   action/endpoint instead. The frontend and the EHR webhook caller may
   be on stale code paths.

6. **Never write to `query_history` or `kb_entries` from the client
   directly.** Always go through `/.netlify/functions/kb` so auth is
   validated server-side.

7. **Don't push to `main`.** Develop on branches under `claude/...`.

---

## Conventions (follow these)

### Code style
- Vanilla JS, ES2017+ (async/await, spread, const/let). No TypeScript.
- 2-space indent, semicolons, single quotes for JS strings, double quotes
  for HTML attributes.
- Function names: `camelCase`. CSS class names: `kebab-case`.
- Comments only when the *why* is non-obvious. Don't narrate the *what*.

### CSS
- Class-based selectors only. Inline `style=""` is reserved for runtime
  dynamic values (a JS-set color, etc.). Never paste a multi-property
  inline style block — extract to a class.
- New CSS goes in the right thematic section in `styles.css` (TOPBAR,
  TRIAGE LAYOUT, KB TAB, HISTORY, etc.). Add a new section comment if
  the concept is new.
- Use the existing CSS variables (`--blue`, `--gray-500`, `--fs-sm`).
  Don't introduce raw hex values or pixel font sizes.

### Database
- All schema changes go through `migrations/NNNN_name.sql` (zero-padded
  4 digits, snake_case). Never edit a previous migration after it's been
  applied. Add a new one.
- Every table has `created_at timestamptz DEFAULT now()` and an
  `id uuid DEFAULT gen_random_uuid()` primary key unless documented
  otherwise.
- RLS is enabled on every table; tenant-scoped tables filter by
  `company_id`.

### Errors & logging
- Server: `console.error('<function>.<context>:', err.message)` — Netlify
  captures this in function logs.
- Client: catastrophic errors render a friendly fallback panel (see
  `runTriage` for the pattern). Recoverable issues surface via
  `showToast(msg, 'error')`.

### Adding a feature
- Smallest possible change. One commit per logical change.
- If it adds a DB column, add the migration in the same commit.
- If it adds a public function, add the test in `tests/` in the same
  commit.

---

## Anti-patterns observed in this codebase

When the chat-based predecessor wrote code, these patterns kept showing up.
Don't repeat them.

- **Whole-file rewrites** that drop unrelated working code. Use targeted
  edits (`Edit` tool with small `old_string`/`new_string`) — never write
  a 1000-line file from scratch unless you've just read all 1000 lines.
- **Half-removed features** where the UI is gone but the backend handler
  still exists, or vice versa. When removing a feature, search across
  `app.js`, `kb.js`, `index.html`, `styles.css` for every reference and
  remove all of them in one commit.
- **Dead branches**: `if (s === 'snippets') return 'notes' else return 'notes'`.
  When you find one, delete it; don't preserve it "just in case."
- **Two sources of truth** for one value. Centralize in `data/defaults.js`
  or pass through a single function.
- **Inline styles for static values.** Refactor to a CSS class.

---

## When in doubt, ask

If a requested change would violate any rule above, would touch more than
3 files, or would change the data model, stop and confirm with the user
before proceeding. Cheaper to ask than to revert.
