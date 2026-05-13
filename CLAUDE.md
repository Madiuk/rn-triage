# Relai

Relai is a clinical triage SaaS that processes inbound patient messages using
AI-assisted classification (Anthropic Claude API). The product is currently
pre-launch, single-tenant for Big Easy Weight Loss (a real medical practice),
being prepared for multi-tenant deployment.

Stack: vanilla JS SPA in `app.js`, Netlify Functions (Node.js) in
`netlify/functions/`, Supabase (Postgres) for the database, Anthropic Claude
Sonnet 4.6 and Haiku 4.5 for classification.

This is clinical software. Bugs in the triage classification path can affect
patient care. The quality bar is higher than a typical SaaS project. The
instructions below reflect that.

---

## About the human you're working with

The project owner is a registered nurse (BSN) and former 911 paramedic with
15+ years of clinical experience. He last did serious programming in the LAMP
era and is rebuilding modern programming vocabulary. He understands software
architecture concepts at a high level but may not recognize current idioms,
framework-specific shorthand, or recent tooling vocabulary.

Communicate accordingly:
- When you use idiomatic phrases (e.g. "smoke test," "happy path,"
  "fan-out," "monkey patching," "yak shaving"), define them briefly at the
  end of your response in a section titled "GLOSSARY NOTES."
- Be selective with glossary notes. Only flag non-obvious idioms, jargon,
  or terms with specific technical meaning different from everyday meaning.
  Don't flag basic terms like "function" or "variable."
- When explaining something new, a brief LAMP-era analogy is welcome if one
  is genuinely apt. Don't force it.
- Assume clinical instincts are sharp. Software instincts are being rebuilt.

---

## Behavioral rules

1. **Describe before changing.** When asked to make a change, first describe
   what you propose to change, what files you'll touch, and what could
   break. Wait for explicit confirmation before editing code.

2. **One thing at a time.** Do not make sweeping changes across multiple
   files in a single response unless explicitly asked. A "sweeping change"
   is any change that touches more than three files, or any change that
   modifies more than one logical concern at once. If a change would qualify
   as sweeping, stop and propose it as a sequence of smaller changes.

3. **Never refactor without tests.** If you plan to change the behavior of a
   function in the triage classification path, first verify there is a test
   that pins down the current behavior. If there isn't, propose the test
   first, get approval, then refactor.

4. **Flag clinical-sensitive changes.** The following are
   clinically-sensitive and must be flagged explicitly:
   - The classification prompt sent to Claude
   - The response parsing or validation logic
   - The confidence threshold or confidence-gating logic
   - The routing rules that map urgency to destination
   - The KB retrieval logic
   - Any database write that affects message state or audit logs
   When proposing a change to any of these, begin your response with:
   "CLINICAL-SENSITIVE CHANGE PROPOSED:"

5. **Prefer correctness over speed.** Given two solutions, choose the more
   explicit and readable one. Verbose, readable code is the goal. Cleverness
   is a liability in clinical software.

6. **When uncertain, ask.** If you don't have enough context to be
   confident, ask a clarifying question. Do not guess. Do not assume intent.

7. **No quality-pass loops.** If asked to "find issues" or "do a quality
   pass," produce a finite, scoped list (e.g. "list all functions with no
   input validation"). Do not produce open-ended "here are things I noticed"
   lists. Do not start fixing issues during a review pass. Review and fix
   are separate phases.

8. **Respect the test suite.** If a test fails after your change, do not
   modify the test to make it pass unless explicitly told to. A failing test
   after a change is information, not an obstacle.

9. **No scope creep.** If asked to do X and you notice Y is also broken,
   mention Y in a single sentence at the end of your response. Do not fix
   Y. Do not propose to fix Y in the same response. Y is a separate task.

---

## Hard constraints

These are non-negotiable.

- **Multi-tenant isolation.** Any query, function, or endpoint that touches
  tenant-scoped data must scope to the current tenant. If you write code
  that could return data from the wrong tenant, that is a critical bug,
  not a stylistic issue. Flag it loudly.

- **No raw patient content in logs.** Do not log raw patient message bodies
  in plaintext. Hashes, lengths, classifications, and metadata are fine.

- **No secrets in code.** API keys, tokens, and credentials live in
  environment variables, never in source files. If you see one committed,
  flag it as a "POSSIBLE SAFETY ISSUE" at the top of your response.

- **No silent failure on classification.** If Claude's classification
  response is malformed, missing required fields, or fails schema
  validation, the message must route to human review with the failure
  logged. Never let a malformed response flow through to automated routing.

- **Database changes require review.** Any modification to files in
  `migrations/` must be flagged as "CLINICAL-SENSITIVE CHANGE PROPOSED" and
  explicitly described before being written.

---

## When you notice concerning things

If you notice something that could be a clinical safety issue (a code path
that could silently drop a message, a confidence gate that could be bypassed,
a tenant boundary that could leak), say so clearly at the top of your
response, even if it's outside the scope of what was asked. Use the phrase
"POSSIBLE SAFETY ISSUE:" so it can be searched for later.

If you notice something that could be a security issue (exposed credentials,
unsanitized input flowing to a sensitive context, missing auth on an
endpoint), use the phrase "POSSIBLE SECURITY ISSUE:" at the top.

These are not requests to fix the issue. They are flags for the human to
address separately.

---

## End of instructions
