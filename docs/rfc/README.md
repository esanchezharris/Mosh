# docs/rfc/ — the go-forward decision log

Architecture decisions for Mosh, going forward, one file per decision.

## Relationship to the other architecture docs

- [`../../ARCHITECTURE_REVIEW.md`](../../ARCHITECTURE_REVIEW.md) is the **frozen v0 decision
  record** — every significant choice made during the initial build, with rationale and the
  rejected alternative. It does not grow.
- **`docs/rfc/` is the append-only go-forward decision log.** Any architectural change made
  *after* the v0 record gets an RFC here: the problem, the options weighed, the decision, and —
  non-negotiably — how the change will be verified.
- [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) stays the **map** of what is actually built.
  When an RFC's work lands, ARCHITECTURE.md absorbs the new map and the RFC's status flips to
  `implemented`. The RFC keeps the *why*; ARCHITECTURE.md keeps the *what/where*.

So the reading order for "why is it like this?" is: ARCHITECTURE_REVIEW.md for anything from the
v0 build, then this directory for everything since.

## Naming

`NNN-slug.md`, zero-padded, monotonically increasing (`001-moshops-partial-class-split.md`).
Numbers are never reused, including for rejected RFCs. [`INDEX.md`](INDEX.md) is the ledger;
reserve a number there before writing the RFC if lanes are running in parallel.

## Statuses

```
draft -> accepted -> implemented
              \-> superseded
              \-> rejected
```

- **draft** — written, not yet decided. May be edited freely.
- **accepted** — the decision is made; implementation may proceed. From here the RFC is
  append-only: corrections go in the Status log, not by rewriting history.
- **implemented** — the work landed and ARCHITECTURE.md absorbed the new map. Terminal.
- **superseded** — replaced by a later RFC (name it in the Status log). Terminal.
- **rejected** — decided against. Terminal; keep the file, the "rejected because" is the value.

## Writing one

Copy [`TEMPLATE.md`](TEMPLATE.md) and fill every section, in order. The Verification section is
**mandatory and must be concrete** (gate lane, RED-proofs, oracles) — this repo's recorded
failure mode is verification that cannot fail
([the vacuous-verification gotcha](../../CLAUDE.md)), and an RFC without a falsifiable
verification plan is not accepted. Add a row to [`INDEX.md`](INDEX.md) in the same PR.
