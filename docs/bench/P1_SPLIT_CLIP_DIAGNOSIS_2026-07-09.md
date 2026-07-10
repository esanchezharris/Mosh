# P1 split_clip diagnosis (2026-07-09 consolidation session)

From `eval_results.a3b-r4-cuda-A-tunnel-serial.json` perExample + `evalA`/`diag_floor4` fixtures:

- 6/6 split_clip rows failed: 5× `apply errors: split_clip: split point outside clip`, 1 deferral.
- Fixture geometry: Keys midi clip = start 4, length 8 → occupies [4,12]; Sub tone clip = [0,3].
- Rows #0–#3 ("split Keys at 8s"): absolute t=8 lies strictly inside [4,12] — a literal emission
  passes. The observed rejections are consistent with the model emitting clip-RELATIVE times on
  offset clips (8 relative → 12 = exact end → rejected by the strict inequality), i.e. the exact
  mechanism the r3 read identified (all training clips started at 0, so relative==absolute was
  never disambiguated). v4's 94 corrective rows did not clear it on the CUDA run.
- Rows #4–#5 are **degenerate fixtures**: "Split the Sub clip at 4 seconds" but Sub = [0,3] —
  the literal correct command CANNOT succeed. Eval-side fixture bug; 2 of the 6-row floor is noise.
- Codex was mid-investigation: `diag_floor4.eval.jsonl` (floor-diagnostic set) and
  `evalA.prompts.corrected.jsonl` exist in the banach worktree.

## Prescribed fix (matches docs/bench/R4_CUDA_GATE_MISS_FIX_PLAN_2026-07-09.md §P1)

1. Fixture repair: Sub-clip rows must ask for an in-bounds split (or the clip must be longer).
2. Boundary normalization in BOTH apply surfaces (MoshOps.cpp `cmdSplitClip` + `bridge.mock.ts`):
   - if `t` falls outside [start, start+len] but `start + t` is strictly inside → interpret as
     clip-relative (`t := start + t`);
   - epsilon comparison at exact start/end boundaries; reject only truly-outside values, with the
     resolved point + clip range in the error;
   - tests: offset clip absolute, offset clip relative, exact boundaries, truly outside.
3. Rerun order unchanged: land fix → short pod serve of the archived a3b-r4-cuda adapter →
   re-read evalA/frozen300/§B → r5 decision from surviving misses.

Status: diagnosis complete; implementation queued behind the PR-queue clear (Phase 1b).
