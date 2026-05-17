# INTERCOM_SETUP.md — Connecting an Intercom workspace to Care Station

Operational runbook for wiring an Intercom workspace into Care Station's
ingestion pipeline. Use this when onboarding a new tenant's Intercom
integration, or when reconfiguring an existing one.

Last updated: 2026-05-16.

---

## Architecture summary

Care Station's Intercom integration is **inbound-first** today and adds
outbound replies in a later phase.

- **Inbound:** Intercom POSTs webhook events to a Netlify function
  ([`netlify/functions/intercom.js`](netlify/functions/intercom.js)) when
  patients send messages. The function verifies the HMAC signature,
  deduplicates by external ID, sets the `fin_participated` flag if
  Intercom's AI Agent ("Fin") was involved, and inserts a row into
  `query_history` with `status='pending'`. The
  [worker](netlify/functions/worker.js) later picks up pending rows
  and runs triage via [`_lib/triage-core`](netlify/functions/_lib/triage-core.js).
- **Outbound** (Week 3 ROADMAP): staff send replies via the
  `/queue/send` endpoint, which calls Intercom's REST API to post the
  reply back into the conversation. Not active yet.

---

## Prerequisites

- The tenant has a row in Supabase `companies`. Record the UUID — you'll
  use it in step 5.
- Care Station is deployed to Netlify and the most recent main-branch
  push has finished building.
- You have admin access to the tenant's Intercom workspace.
- You can create apps in Intercom's Developer Hub.

---

## Step 1 — Create a dedicated Intercom app

**Each Care Station tenant gets its own Intercom app.** Do not share an
app across integrations.

Why dedicated:
- Per-app rate limit, separate from any other integration on the same
  workspace.
- Clean audit attribution — Intercom's logs show which app made which
  API call.
- Independent rotation if a secret leaks.
- Per-app permission scopes that can be narrowed without affecting
  other integrations.

Steps:

1. Sign in to Intercom Developer Hub for the tenant's workspace.
2. Create a new app. Name it something like "Care Station — `<tenant
   short name>`" so it's identifiable.
3. Skip OAuth setup; this is a workspace-scoped app, not a public
   marketplace integration.

---

## Step 2 — Install the app on the tenant's workspace

From the new app's page in Developer Hub, install it onto the tenant's
workspace. This generates the credentials you'll need in step 4.

---

## Step 3 — Subscribe to webhook topics

In the app's **Webhooks** section, add a subscription with:

| Field | Value |
|---|---|
| **Topics** | `conversation.user.created`, `conversation.user.replied` |
| **Endpoint URL** | `https://<your-netlify-domain>/.netlify/functions/intercom` |

Notes:

- HTTPS only. No trailing slash on the URL.
- The function name is `intercom` (lowercase, matches `netlify/functions/intercom.js`).
- Care Station's webhook handler 200-acks any topic outside the two
  subscribed ones, so Intercom won't retry events we don't care about.
- The API version is set at the **app level**, not per-webhook. Pin it
  to **2.15 or later** — 2.15+ delivers plaintext message bodies in the
  payload, which our handler is designed against.

Save the subscription. Don't run Intercom's "Test endpoint" feature
yet — env vars need to be configured first (steps 5–6) or the test
will fail with `500 INTERCOM_WEBHOOK_SECRET not configured`.

---

## Step 4 — Copy credentials

From the app's **Authentication** / **Basic Information** page in
Developer Hub, copy:

- **Client Secret** (sometimes labeled "Application Secret" or
  "Signing Secret"). This is the HMAC key used to verify inbound
  webhook signatures. Goes into `INTERCOM_WEBHOOK_SECRET`.

You will see an **Access Token** on the same page. **Do not** put it
in env vars yet — Care Station's current code is inbound-only. The
access token is needed in Week 3 when the outbound reply flow lands
(it'll get its own env var then, likely `INTERCOM_ACCESS_TOKEN`).

---

## Step 5 — Set Netlify env vars

Netlify Dashboard → the Care Station site → **Site configuration** →
**Environment variables**.

### New vars

| Key | Value | Scope |
|---|---|---|
| `INTERCOM_WEBHOOK_SECRET` | Client Secret from step 4 | Production (or "All deploy contexts") |
| `INTERCOM_TENANT_COMPANY_ID` | The tenant's `companies.id` UUID (see below) | Production |

To find the `INTERCOM_TENANT_COMPANY_ID`, run this in the Supabase SQL
Editor against the project that backs production:

```sql
select id, name from companies;
```

Copy the `id` value (looks like `a3f8c4d2-...`) for the tenant you're
onboarding. **This is server-only configuration; tenant ID never comes
from request input** — per CLAUDE.md's tenant-scoping rule.

### Existing vars to verify are set

| Key | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Triage helper authenticates against Anthropic |
| `SUPABASE_URL` | All DB-touching functions |
| `SUPABASE_SERVICE_KEY` | Function-side writes bypass RLS |

These should already be set from prior Care Station work. If any are
missing, the corresponding function returns `500 X not configured` and
the function logs make it obvious.

### Common pitfalls

- **Wrong deploy context.** Netlify scopes env vars by context. Make
  sure the new vars apply to **Production**, not just "Local
  development."
- **Whitespace.** A leading or trailing space in the Client Secret
  value will fail signature verification with a `401`.
- **Typo in the variable name.** It's `INTERCOM_WEBHOOK_SECRET` —
  uppercase, no plural, no underscores beyond what's shown.

---

## Step 6 — Trigger a Netlify redeploy

Netlify functions read `process.env` at module-load time. Adding an
env var doesn't propagate to running function instances automatically;
new cold starts will pick it up, but anything already warm uses the
old values.

Force a clean redeploy:

- Netlify Dashboard → **Deploys** → **Trigger deploy** → **Clear
  cache and deploy site**.

Wait for the deploy to go green.

---

## Step 7 — Verify the endpoint

Two ways to verify the function is healthy:

### From the terminal

```bash
curl -i -X POST https://<your-netlify-domain>/.netlify/functions/intercom -d '{}'
```

Expected: `401 {"error":"Invalid webhook signature"}`. This is the
**healthy** state — the function is being reached, env vars are
loaded, and signature verification correctly rejects an unsigned
request.

If you see:

- `500 {"error":"INTERCOM_WEBHOOK_SECRET not configured"}` → the env
  var isn't set or the redeploy hasn't completed.
- `500 {"error":"INTERCOM_TENANT_COMPANY_ID not configured"}` → same,
  for the other var.
- `404` → URL is wrong or the function isn't deployed.
- A DNS error → the custom domain isn't pointing at Netlify yet.

### From Intercom Developer Hub

Use Intercom's **Test endpoint** feature in the webhook subscription
settings. It sends a signed test payload. Expected: 2xx success.

If Intercom reports a failure here but the curl above returned a
clean `401`, the Client Secret in Netlify likely doesn't match what
Intercom is using. Re-copy from Intercom Developer Hub (watch for
whitespace), update the Netlify env var, redeploy, retry.

---

## Step 8 — End-to-end smoke test

1. Send a test message in the tenant's Intercom workspace. Use a
   non-patient contact (your own account is fine). **No real patient
   content — see CLAUDE.md non-negotiables.**

2. **Check Netlify function logs.** Dashboard → **Functions** →
   `intercom` → **Logs**. Look for the request and a `success: true,
   task_id: <uuid>` response.

3. **Check Supabase.**

   ```sql
   select id, source_channel, status, fin_participated, patient_message, created_at
   from query_history
   order by created_at desc
   limit 5;
   ```

   Fresh row should appear with `source_channel='intercom'`,
   `status='pending'`, `fin_participated=false` (unless Fin is enabled
   in the workspace and engaged in this conversation).

4. **Manually invoke the worker.**

   ```bash
   curl -X POST https://<your-netlify-domain>/.netlify/functions/worker
   ```

   Returns a JSON summary like
   `{"processed":1,"counts":{"triaged":1},...}`.

5. **Re-check the row.** Should now be `status='triaged'` (or
   `'reviewed'` if Care Station's safety pipeline routed to human
   review — parse failure, validation failure, tripwire match, or
   Haiku second-pass disagreement). Classification fields populated:
   `clinical_category`, `urgency_score`, `clinical_routing_level`,
   `draft_response`, `ai_confidence`.

If `fin_participated=true` is on the row, the worker sets `status='reviewed'`
with an explanatory `internal_note` and **does not call Claude**. This
is the defense-in-depth check against Intercom's AI Agent (see
[migration 0023](migrations/0023_query_history_fin_participated.sql)).

---

## Operational notes

- **API version 2.15+** is required at the app level for plaintext
  message bodies in webhook payloads. Earlier versions deliver HTML
  bodies and our parser would need an extra strip step.
- **Webhook retry policy.** Intercom retries 5xx responses (and timeouts)
  for ~24h with backoff, then disables the subscription. Our handler
  200-acks signature-verified unsupported topics so they're never
  retried.
- **5-second ACK timeout.** Intercom expects a response within 5s. Our
  handler defers triage to the worker (async), so the inbound ack is
  fast — no Anthropic call on the request path.
- **No-DELETE policy.** Care Station never initiates destructive
  operations on Intercom conversations. The Intercom DELETE
  `/conversations/{id}` endpoint is **not** exposed in our outbound
  surface. Receiving deletion notifications from upstream
  (`conversation_part.redacted`) is observation, not initiation, and is
  fine.
- **Worker scheduling.** The worker isn't auto-scheduled yet — per the
  [ROADMAP](ROADMAP.md), scheduler activation lands in Week 4. Until
  then the worker runs only when manually invoked.

---

## Multi-tenant future

Today's setup is **single-tenant** — `INTERCOM_TENANT_COMPANY_ID` is a
process-level env var that maps every inbound Intercom webhook to one
tenant. When Phase 4 multi-tenancy lands, tenant identification will
move to a different mechanism:

- Per-tenant webhook URLs like
  `/.netlify/functions/intercom/<tenant-slug>` so the function can
  resolve tenant from the path.
- Or per-tenant API keys whose ID looks up the tenant in a `channels`
  table.

The `intercom.js` handler comments call out this transition.

---

## Common issues quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| `500 INTERCOM_WEBHOOK_SECRET not configured` | Env var missing or wrong scope, OR redeploy not yet propagated | Set var in Netlify (Production scope) → Clear cache + redeploy |
| `500 INTERCOM_TENANT_COMPANY_ID not configured` | Same, for the tenant UUID env var | Set var in Netlify → redeploy |
| `401 Invalid webhook signature` from a curl with `-d '{}'` | Expected and healthy | Try Intercom's signed test instead |
| `401 Invalid webhook signature` from Intercom's signed test | Wrong Client Secret in env var (typo, whitespace, copied access token instead) | Re-copy from Intercom Dev Hub → update env var → redeploy |
| `404` | Domain not pointing at Netlify, OR function not deployed, OR wrong path | `nslookup <domain>`; check Netlify Deploys tab |
| Webhook subscription auto-disabled in Intercom | Endpoint returned 5xx for too long | Fix the endpoint, then re-enable the subscription in Developer Hub |

---

## Cross-references

- [intercom.js](netlify/functions/intercom.js) — inbound webhook handler
- [worker.js](netlify/functions/worker.js) — processes pending rows, runs triage
- [triage-core.js](netlify/functions/_lib/triage-core.js) — shared triage orchestration
- [migration 0023](migrations/0023_query_history_fin_participated.sql) — Fin defense column
- [ROADMAP.md](ROADMAP.md) — the build plan
- [PLAN.md](PLAN.md) — the principles
- [CLAUDE.md](CLAUDE.md) — working agreement and non-negotiables
