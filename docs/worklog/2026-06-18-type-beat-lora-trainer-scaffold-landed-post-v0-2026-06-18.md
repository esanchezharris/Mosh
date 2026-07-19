# Type-beat LoRA trainer — scaffold landed (post-v0, 2026-06-18)

_Working note, 2026-06-18. Moved verbatim out of CLAUDE.md; content unchanged._

**Type-beat LoRA trainer — scaffold landed (post-v0, 2026-06-18).** The rights-cleared *scaffold* shipped on `main`: a rights registry + eligibility gate, a deterministic SHA256 corpus bundler, and job orchestration (`src/training/`, `service/training/`, 10 additive non-undoable `MoshOps` commands, `/training/*` service routes), behind a **fake** training backend and a WIP `LoRA` topbar popover (no progress/error UI yet). The REAL on-device LoRA training backend + vector layering stay deferred (below).
