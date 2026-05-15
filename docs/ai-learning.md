# AI learning behavior

This doc covers the two mechanisms that shape how the triage AI writes
patient-facing drafts: the **Writing Style** KB section and the **few-shot
staff examples** block. Both were added together; together they're how the
AI is supposed to learn the way *your nurses* actually communicate, instead
of defaulting to a generic AI voice.

If a draft comes back sounding wrong (em-dashes, stock phrases, brochure
cadence), this is where you adjust.

---

## 1. Writing Style KB section

### What it is

A regular KB section, just like Side Effects or Protocols, called
**Writing Style**. It's the last tab in the KB. Every entry in it is
included in the system prompt on every triage as part of the cached KB
block.

### How to edit it

Open the **Knowledge Base** tab in the top nav. Click the **Writing
Style** tab. You'll see five seeded rules:

1. No em-dashes or en-dashes
2. No semicolons
3. Use contractions
4. Avoid stock AI phrases
5. Short, varied sentence length

Add, edit, or delete entries the same way you do for any KB section.
Click **Save & Sync to Team** when done.

### How it reaches the AI

The section is appended to the KB system block sent to Claude on every
triage. The section header reads:

> WRITING STYLE -- STRICT (these rules override any default formatting
> habits; apply them to draft_response and internal_note every time)

That framing is what gives the rules authority. Don't soften it without
testing — the AI's default writing habits are strong (em-dashes
especially) and will reassert themselves the moment the framing weakens.

### What works in a rule

- Lead with **STRICT RULE** or **NEVER** for non-negotiables.
- Phrase positively when possible. *"Use commas, periods, or
  parentheses for pauses"* works better than *"Don't use dashes"*
  alone — mentioning the forbidden token can paradoxically prime the
  model. The seeded rules do both: forbid clearly, then provide the
  positive replacement.
- Give examples. *"Wrong: 'Nausea is common; it improves.' Right:
  'Nausea is common. It improves.'"*
- Keep rules narrow. One rule = one rule. Don't combine "no dashes
  and no semicolons and short sentences" into a single entry.

### When you edit, the AI sees the change on the next triage

KB edits invalidate the local cache immediately. The next triage call
uses the new KB. There's no deploy step.

### What this changes in the version stamps

Adding, editing, or deleting any entry in this section bumps the
`kb_version` hash, same as any other KB edit. The
`/history/quality` view groups results by `kb_version`, so you can see
the before/after correction rate for any KB change. Style rules are
expected to *lower* the correction rate over time. If a rule lowers
draft quality, it'll show up there.

---

## 2. Few-shot staff examples

### What it is

A small block injected into every triage's system prompt containing
three real recent drafts from your team, formatted as:

```
EXAMPLE 1
Patient message: "..."
AI draft (what you would have written): "..."
What the nurse actually sent: "..."
```

The AI is told to **match the nurse's version, not the prior AI's
version**. This is the highest-leverage way to teach voice — far
stronger than abstract rules. Every time a nurse edits a draft, the
edit becomes future training context.

### What corrections qualify

A row is eligible when:
- The nurse actually sent a draft (`actual_response_sent` is set)
- An AI draft exists (`draft_response` is set)
- The edit was meaningful: at least 40 characters changed
  (`edit_distance >= 40`). This filters out typo fixes that don't
  teach voice.
- The patient message is at least 20 characters. Skips "thx" replies
  that give the AI nothing to anchor on.

The three most-recent qualifying rows are used.

### How it loads

Lazily, on the first triage of each browser session. The fetch hits
`/history` (existing endpoint) and the result is cached in memory for
the rest of the session. Cost: roughly 100-300ms of extra latency on
the very first triage. Zero added latency on every subsequent triage.

If the fetch fails, examples are silently disabled for the session and
the triage continues without them. No user-visible error.

### How to "refresh" the examples

There's no Refresh button by design. The examples update at the start
of each new session — close the tab and reopen, or hard-refresh, and
the next triage picks up any new corrections. This keeps the
mechanism invisible: you correct drafts as part of your normal
workflow, and the AI sees those corrections as examples on your next
session.

### Why no manual refresh

If you could mash a button to re-pull examples mid-session, you'd
spend time fiddling with the AI instead of doing patient work. Once
per session is enough — corrections accumulate slowly enough that
in-session refreshes wouldn't change the example set anyway.

### Token cost

Each example is roughly 150-250 tokens. Three examples = roughly
450-750 input tokens per call, uncached. At Sonnet rates that's about
$0.001-$0.002 per triage. Small.

### What this changes in the version stamps

Nothing. The few-shot block is *not* part of `prompt_version` or
`kb_version`, because the examples change continuously as corrections
accumulate. Stamping a new version every time would shred the
quality breakdowns. Treat the few-shot mechanism as a constant
ambient improvement that bleeds into all triage rows after the
feature shipped.

---

## How to tell whether it's working

### Quick check (one triage)

After deploy, run a triage on a typical message. Look at
`draft_response`. Does it contain:
- Em-dashes? Rule 1 failed.
- Semicolons? Rule 2 failed.
- "I understand your concern" / "Great question" / "Feel free to" /
  "It is important to note"? Rule 4 failed.

If yes, the rules aren't holding. Possible causes (in order of
likelihood):
1. Browser is still showing a cached `kb` — hard refresh the tab.
2. The rule wording is too soft. Strengthen with **STRICT** and
   concrete forbidden tokens.
3. The base prompt is undermining the rule. (Unlikely — base prompt
   says nothing about formatting.)

### Slow check (over a week)

Watch `/history/quality` for correction_rate by `kb_version`. Right
after the style rules ship, you'll see a new `kb_version`. Compare
its correction_rate to the prior version. A reduction is the signal
the rules are landing.

### Tell that something's off

- New entries in the Writing Style section that contradict existing
  ones (e.g. one says "no contractions" and another says "use
  contractions"). The AI can't follow both. Pick one.
- Examples block keeps suggesting voice the staff aren't actually
  using. Usually means there's a single high-edit-distance correction
  that's an outlier (a patient escalation, an unusual case) — refresh
  the session to pull a new sample.

---

## What the AI does NOT learn from

Things that don't feed back into AI behavior:
- Upvotes and downvotes on drafts. These are tracked for analytics,
  not used as training context.
- Comments in the Corrections tab. Not surfaced to the AI.
- The `correction_note` text. Not surfaced either.

If you want the AI to learn something, either edit the draft (which
becomes a few-shot example) or write a Writing Style rule (which
becomes part of the KB).

---

## Implementation pointers

For future maintainers:

- Style section: defined in `data/defaults.js#kb_sections` with key
  `style`. Seeded in `data/default-kb.js`. Rendered by the same
  `renderKB()` pipeline as every other section in `app.js`.
- Few-shot examples: `loadStaffExamples()` and `getStaffExamplesBlock()`
  in `app.js`, just below `getFullKB()`. Wired into `runTriage()` as the
  third (uncached) system block.
- Eval parity: the eval harness in `eval/run.js` does *not* include
  the few-shot examples block (it has no session-specific
  corrections). The Writing Style section *is* included
  automatically, because the eval reads `data/default-kb.js` and the
  section now lives there. This means eval scores will reflect style
  rule changes but not few-shot effects.
- `kb_version` covers Writing Style edits. `prompt_version` is
  unchanged.
