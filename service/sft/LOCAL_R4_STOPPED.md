# Local `a3b-r4` Lane Status

The detached local MLX `a3b-r4` training lane was intentionally stopped on July 9,
2026 at the user's request during the CUDA cutover.

Authoritative stopped-runtime marker:

```text
/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/intelligent-banach-25ad5f/service/sft/.adapters/a3b-r4.STOPPED
```

Stopped state:

- local progress preserved at `5200 / 12889` steps
- local watchdog stopped
- local `com.mosh.r4-watchdog` LaunchAgent removed
- local MLX training process stopped

Active successor lane:

- RunPod pod id: `gc3v0gpji7xskt`
- remote runtime root: `/workspace/ClaudeMosh/service/sft`
- remote adapter dir: `/workspace/ClaudeMosh/service/sft/.adapters/a3b-r4-cuda`

Do not treat the local `.adapters/a3b-r4` directory as the active training seat
unless a later decision explicitly revives it.
