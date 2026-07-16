# Cycle-3 (a3b-r4) training — handoff / protection guide

> ⛔ **SUPERSEDED (2026-07-09): the local r4 run this doc protects was intentionally STOPPED
> at 5200/12889 during the CUDA cutover** — see [`LOCAL_R4_STOPPED.md`](LOCAL_R4_STOPPED.md).
> The watchdog, LaunchAgent, and MLX process were all torn down; do **not** restart them.
> r4 completed on a RunPod CUDA pod ([`GATE_READ_a3b-r4-cuda.md`](GATE_READ_a3b-r4-cuda.md),
> §P8 gate = MISS on measurable floors → fix-first decision) and r5 followed on CUDA
> ([`GATE_READ_a3b-r5-cuda.md`](GATE_READ_a3b-r5-cuda.md), §P9 gate = **PASS**). The text
> below is kept as the reference runbook shape for a future LOCAL MLX run only.

**The training is a detached OS process (watchdog PPID = 1). It does NOT depend on any
Claude/Codex session.** A Claude usage-limit hit, closing the editor, or ending the
session does **not** touch it. Closing the laptop lid just *suspends + resumes* it
(hibernatemode 3). Only a **full reboot/shutdown** stops it — see "After a reboot".

Everything lives under `service/sft/`. The mix is `s2-mix-v4` (§P8, 12,889 rows).

## Check status (safe, read-only)
```sh
cd <repo>/service/sft
./monitor-r4.sh
```

`monitor-r4.sh` is the canonical thread-safe status surface. It always reads the live
runtime path in the detached worktree, reports `done/12889`, training + watchdog
liveness, the latest train/val line, gate status, and the action required. It is
read-only while the run is in flight.

## Working alongside it (Codex or any agent) — the ONE rule
The Mac runs **one MLX GPU job at a time**: this training owns the GPU + port 8080.
So while it runs, do **not**: start another `mlx_lm` process, run the generative
service/SA3, or `Mosh --selftest` with SA3 on. Everything else is fine — code edits,
`npm` builds/tests, `git`, the C++ build, running the app UI. Transient GPU contention
(e.g. Ableton) is expected; the watchdog auto-recovers from the OOMs it causes.

## After a reboot (the only thing that kills it)
The nohup'd watchdog dies on shutdown. Restart it — it reads `.done` and continues
from the last checkpoint, losing nothing:
```sh
cd <repo>/service/sft
nohup ./watchdog-r4.sh > /tmp/watchdog-r4.log 2>&1 & disown
```
(`watchdog-r4.sh` refuses if an mlx proc is already running, so double-launch is safe.)

### Auto-resume on boot — INSTALLED (LaunchAgent `com.mosh.r4-watchdog`)
A LaunchAgent is installed at `~/Library/LaunchAgents/com.mosh.r4-watchdog.plist`
(RunAtLoad, no KeepAlive). On every boot/login it runs `boot-resume-r4.sh`, which:
- **no-ops** if a watchdog / training proc is already alive (no duplicate GPU jobs),
- **resumes** the watchdog from the last checkpoint if the run is incomplete and dead,
- **self-removes** (bootout + deletes its own plist) once `.done` ≥ 12,889.

So a reboot needs zero manual action — it auto-resumes on login. Nothing to do.
Remove it manually any time:
```sh
launchctl bootout "gui/$(id -u)/com.mosh.r4-watchdog"
rm -f ~/Library/LaunchAgents/com.mosh.r4-watchdog.plist
```
Boot-resume log: `/tmp/watchdog-r4-boot.log` (+ `/tmp/com.mosh.r4-watchdog.{out,err}`).

## When training COMPLETES (`.done` = 12889, watchdog logs "COMPLETE")
`monitor-r4.sh` auto-hands off to `run-gate-r4.sh` the first time it sees completion
with no live MLX process and no completed gate status. You can also invoke it directly:
```sh
cd <repo>/service/sft
./run-gate-r4.sh
```

The explicit runbook is `service/sft/GATE_READ_r4.md`. It fuses the adapter,
weight-checks the fused shards, serves the fused dir, runs §C + §A + §B, and records
status in `.adapters/a3b-r4.gate.status` plus the raw log in
`.adapters/a3b-r4.gate.log`. Gate (§P8): agg §A+§C ≥0.75 · floor ≥0.5 measurable ·
§B ≥85%. **Expectations:** `split_clip` should now clear (the offset fix);
`set_render_param` is a best-effort n=1 item that may stay a named exception — report
honestly, don't spin. Record the result in `docs/bench/PROGRAM_STAGE1_2026-07.md` §R.

## If it crashes repeatedly (watchdog log shows many "crash #N")
The recipe is fine (r3 ran it clean). Frequent OOMs = heavy concurrent GPU use — close
Ableton/GPU apps, or the watchdog gives up after 30 crashes. Do NOT trim seq/layers
(deviates from the §P8 pre-registration).
