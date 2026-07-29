# RFC index

The ledger of go-forward architecture decisions. See [`README.md`](README.md) for the process
and [`TEMPLATE.md`](TEMPLATE.md) for the required sections.
[`POST-MERGE.md`](POST-MERGE.md) tracks the follow-ups that can only land after the RFC 001/002
split stack merges.

| id | title | status | decided | verification |
|----|-------|--------|---------|--------------|
| [001](001-moshops-partial-class-split.md) | MoshOps partial-class file split | accepted | 2026-07-28 | full native gate per PR; selftest ×3 tallies equal to base-commit build; coverage/model-lint/contract tests green; `--color-moved` review |
| [002](002-selftest-chapter-split.md) | SelfTest chapter split by prefix-motion | accepted | 2026-07-28 | identity oracle: `--selftest` stderr transcript (timing-stripped) byte-identical to base build, ×3; full native gate |
| [003](003-lock-scope-golden-ledger.md) | Lock-scope golden ledger | accepted | 2026-07-28 | RED-proofs: flipped row fails naming the command; bogus-extractor trips the >150 floor |
| [004](004-store-slicing.md) | store.ts slicing (events extraction + zustand slices) | accepted | 2026-07-28 | full vitest + full e2e incl. multiplayer.spec.ts; zero DOM change so no visual run |
| [005](005-classic-shell-decision.md) | Classic-shell decision (freeze-and-sever vs port-and-archive) | draft — decision pending owner | — | per-PR cheap gate + full e2e; boot()-census ratchet + freeze guard RED-proven; spec-twin 1:1 assertion mapping vs the audit table |
