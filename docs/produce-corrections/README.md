# Produce-lane corrections

The produce lane's quality mechanism, per `docs/POSTMORTEM-2026-09.md`'s binding
quality-loop contract: **weekly human correction rounds with written lessons**.
A correction round listens to a produce-lane render, rates it, writes down what's
wrong in plain English, and — only sometimes, only by hand — promotes one lesson
into `PRODUCE_RULES` (`ui/src/agent/loop/producePrompt.ts`). Proxy metrics never
gate a musical decision; only an owner's ear does.

This directory is the produce lane's OWN correction store — the same shape as the
AbletonMONSTER flywheel lab's `flywheel-data/corrections/*.meta.json` (that store
lives outside this repo, at `~/AbletonMONSTER/`, and predates the produce lane;
`gen001-808-register.meta.json` and `mac-r0-001.meta.json` here are the two
corrections that seeded PRODUCE_RULES v1/v2, carried into the repo so the lesson
tags below have something real to point at).

## Filing a correction

After a produce-lane run (`~/Library/Mosh/produce-runs/<runId>/`, or the overnight
driver's `~/Library/Mosh/produce-ab/<date>/runs/<runId>/`), listen to the render,
then run:

```sh
python3 scripts/produce/capture-correction.py \
  --run <runId> \
  --rating pass|pass_with_notes|fail \
  --verdict "one sentence, your own words" \
  --note "first specific thing" \
  --note "second specific thing" \
  [--run-dir ~/Library/Mosh/produce-runs/<runId>]
```

This writes `docs/produce-corrections/<runId>.meta.json` with:

| field | meaning |
|---|---|
| `id` | the correction's own id — the filename stem, referenced by lesson tags |
| `created` | today's date |
| `ask` | the produce-lane ask that produced the run |
| `prompt_version` | `PRODUCE_VERSION` at the time of the run (`producePrompt.ts`) |
| `run` | the run id / path to its `run.json`, `template.json`, transcript |
| `reference` | what the render was judged against (a flywheel `.als`, a prior render, or `null`) |
| `rating` | `pass` \| `pass_with_notes` \| `fail` |
| `user_verdict` | the owner's own one-line summary |
| `notes` | a plain-English list — specific, not scored; each note is addressable by its 1-based position |
| `promoted_to` | `null` until a rule is promoted (see below), then which `PRODUCE_RULES` line(s) |

## Promoting a lesson into the prompt

Promotion is a **separate, deliberate, hand-done step** — never automatic, never
gated on a proxy score. To promote note *N* of correction *id*:

1. Edit `PRODUCE_RULES` in `ui/src/agent/loop/producePrompt.ts`: change or add ONE
   rule line, with a `// lesson: produce-corrections/<id> note <N>` comment
   directly above it (see the existing rules for the pattern — every load-bearing
   taste rule in there traces back to a note here, not to a guess).
2. Bump `PRODUCE_VERSION` (same file).
3. Update the correction's own `promoted_to` field to name the rule.
4. Save a `PROMPT-produce-v<old>-to-v<new>.diff` of the `PRODUCE_RULES` change
   next to this README (or in the run package) — the same paper trail the
   flywheel lab's `PROMPT-trap-v*.md` lineage keeps.
5. `cd ui && npx vitest run src/agent/loop/producePrompt.test.ts` — the lesson-tag
   test fails loudly if a tag points at a correction file that doesn't exist, so a
   promotion can't silently reference a note nobody wrote down.

A rule with no `// lesson:` tag is a MECHANICAL rule (a command shape, a budget, a
JSON contract) — those cite their design fact instead (a `plan`/file:line comment),
never a made-up taste preference. Taste rules come from correction rounds only.
