# RFC NNN — Title

- **Status:** draft | accepted | implemented | superseded | rejected
- **Decided:** YYYY-MM-DD (when status left draft)

## Problem

What is wrong or missing, with **evidence links** — file paths with line counts/ranges, gate
output. A problem statement without a link to the code or to gate output is an assumption, and
this repo's record shows written reasons age badly (re-read the source before trusting a claim,
including this one).

## Invariants touched

Which prime directives (CLAUDE.md) and contracts (MoshOps command surface, snapshot/events feed,
`docs/02_MOSHOPS_CONTRACT.md`, the swappable seam) this change touches — and for each, whether it
is preserved, strengthened, or deliberately changed. "None" is a valid answer but must be stated.

## Options considered

Each option gets a short description and — for every option not chosen — an explicit
**"rejected because"** grounded in this codebase (not in general principle). Mark the chosen
option **CHOSEN** with the deciding reason.

## Decision

The decision in one or two paragraphs, precise enough that an implementer who reads nothing else
builds the right thing.

## Migration / PR plan

The ordered PR sequence, and for each PR its **change-class per
[`scripts/auto-loop/classify.sh`](../../scripts/auto-loop/classify.sh)** — `cheap` (ui/, docs/,
service/relay `*.py`, scripts/auto-loop/), `native` (anything compiled or fingerprint-fed), or
`excluded` (the never-auto-merge set) — plus the **merge authority** that follows from it
(auto-merge on green gate vs. owner-merge).

## Verification

**MANDATORY — an RFC without this section filled in concretely is not accepted.** This repo's
recurring failure mode is vacuous verification: tests that cannot fail look identical to tests
that pass (see the vacuous-verification gotcha in [`CLAUDE.md`](../../CLAUDE.md)). State:

- **Gate lane:** which gate must run per PR (full native gate, cheap gate, e2e, verify.py).
- **RED-proofs:** which new guards must be proven to fail before they are trusted, and how
  (sabotage with an absolute path, verify the restore, `grep SABOTAGE` before landing).
- **Oracles:** the ground truth each PR is checked against (byte-identical transcript, equal
  selftest tallies on the same machine, golden files, `--color-moved` review), and why that
  oracle cannot pass vacuously.

## Status log

Dated one-liners, append-only, newest last.

- YYYY-MM-DD — drafted.
