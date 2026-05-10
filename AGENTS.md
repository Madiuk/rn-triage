# AGENTS.md — Rules for AI agents working on this repo

This file is read by Claude Code (and any other AI coding assistant) at the
start of each session. Every change to this codebase must follow these rules.
If a rule prevents an action, ask the user before bypassing it.

---

## Project shape

- **Relai** is a customer-service triage tool: a message arrives via
  any input **channel** (staff paste, EHR webhook, forwarded email,
  live chat, SMS, web form, etc.), an Anthropic Claude model
  classifies it against a per-tenant Knowledge Base, and returns a
  structured JSON triage decision. Channels are pluggable adapters —
  the rest of Relai (triage, KB, queue, learning, dashboards) is
  channel-agnostic. Currently single-tenant (Big Easy Weight Loss, a
  clinical telehealth practice); architected to become a multi-tenant
  SaaS that's **vertical-agnostic** at the architecture level — the
  next tenant could be another medical practice, a tire repair shop,
  a property management company, or a law firm. The codebase has
  some medical-shaped pieces today (categories, prompt voice, KB
  seeds) because Big Easy is the only tenant; those live at the
  tenant-config layer and are catalogued in PLAN.md's "Vertical-
  agnostic readiness audit." **Don't add new medical assumptions to
  core code.** Anything tenant-specific belongs in `data/defaults.js`
  (fallbacks), the `tenants` table (per-tenant config), or a channel
  adapter. **Bask Health is one channel Big Easy uses, not a
  load-bearing concept** — don't write Bask-specific paths into core
  code; put them in a channel adapter.
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
│   │   ├── ingest.js      generic inbound webhook (any channel —
│   │   │                  EHR, email, Healthie, etc.); idempotent by external_id
│   │   ├── worker.js      background processor for pending ingests (stub)
│   │   └── bask.js        first channel adapter (Bask Health) — stub.
│   │                      future adapters land under channels/ — see PLAN Phase 3
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
- **Inlining UI state into LLM content fields.** Never string-concatenate
  metadata (selected categories, timeframe, dropdown values, etc.) into
  the content payload sent to a model. The model can't tell where
  "content" ends and "metadata" begins, and a comparison-style prompt
  will describe the metadata as if it were content. Always pass UI
  state as a clearly labeled separate block (e.g. `Staff metadata
  (UI selections, NOT response edits): - Timeframe: routine`) and
  instruct the model in the system prompt that the metadata is not
  part of the content. See the long comment above `submitCorrection`
  in `app.js` for the pattern; it's where this rule was learned.

## Auditing LLM call sites

Whenever you touch a place that calls an LLM (`triage.js`, the
`/analyze` route in `kb.js`, the eval harness, any future call site),
do this read:

1. **Print the constructed prompt in your head.** What literally
   reaches the model — system + user content + any extras? Walk
   through every string-template substitution.
2. **Read it as the model.** Is any field ambiguous? Could anything
   in the user content be confused with metadata or instructions?
3. **Trace metadata vs. content.** UI state should never be in the
   content payload. Always a labeled separate block.
4. **Check the no-diff / no-input edge case.** A comparison or
   summarization prompt with nothing to compare/summarize will
   confabulate. Either short-circuit with a deterministic note, or
   instruct the model explicitly to say "no changes" plainly.
5. **Verify the endpoint has auth, a model allowlist, and a
   max_tokens cap.** Anything calling Anthropic on the server's API
   key is a budget-burn vector if those guards are missing.

## Quality-pass audit method (data-integrity focus)

Pattern-matching scans (grep for Bask, dead constants, silent
catches) catch a lot but miss the project-killing class of bug:
silent data corruption, broken learning-loop links, fragile RLS
dependencies. When asked for a "deep" or "real" quality pass,
follow this checklist instead of grep-pattern-matching:

1. **Trace every data write end-to-end.** From UI button → fetch
   payload → endpoint handler → DB column. For each step, ask
   "what happens if this fails silently?" Mark anywhere the failure
   is invisible to the user. Those are the project-killer-class
   bugs.

2. **Check whether the data you claim to be capturing is actually
   being captured.** For every field the AI returns or staff
   produces, is there a column that holds it? Cross-reference the
   prompt's documented JSON output against the saveHistoryRecord
   payload against the schema. Anything missing is a learning
   signal that disappears after each triage.

3. **Audit the active learning loop specifically, link by link.**
   review_request created → row exists → staff sees it → staff
   answers → handler patches review → kb_gap/protocol branch
   triggers `promoteReviewToKB` → kb_entries INSERT → next triage
   uses updated KB. If any link silently breaks (RLS denial, fire-
   and-forget, missing field), the whole loop fails to close. Walk
   it forward and walk it back.

4. **Verify tenant isolation explicitly.** Every query that touches
   a tenant table must be scoped — `company_id=eq.<id>` on reads,
   `id=eq.<row-id>` for individual writes that the user controls,
   `company_id=eq.<id>` for bulk writes. Anything unscoped (`?id=neq.<zeros>`,
   no `where` clause, or relying on RLS to scope you) is a Phase-4
   ship-blocker waiting to happen.

5. **Verify auth guards on every endpoint that writes data or
   calls a paid API.** Anthropic, Supabase service-key writes,
   anything that costs money or persists data. Missing auth is a
   budget-burn or data-tampering vector.

6. **Race conditions in async UI flows.** If `promise.then(x => global = ...)`
   is used and the user can trigger another flow that also sets
   the same global, audit whether the resolution order is
   guaranteed. If not, await the promise instead of fire-and-
   forget.

7. **Cross-check inconsistent classifications of the same row.**
   Severity badge logic, priority tier logic, task shape logic —
   if multiple functions classify a row differently using
   different field reads, the same row can render differently in
   different views and confuse staff. Align them.

8. **Don't stop at three.** Each audit pass on Juno (v0.3.0
   foundation) found bugs the previous pass missed. The pattern
   is: pattern-matching catches the easy ones, semantic flow
   catches the next layer, end-to-end data tracing catches the
   project-killers. Don't declare an audit "done" until you've
   actually traced data flow with adversarial intent on every
   write path.

---

## When in doubt, ask

If a requested change would violate any rule above, would touch more than
3 files, or would change the data model, stop and confirm with the user
before proceeding. Cheaper to ask than to revert.
