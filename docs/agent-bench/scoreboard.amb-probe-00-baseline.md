# MoshAgentBench — amb-probe-00-baseline

model `claude-sonnet-5` @ `claude-cli(subscription)` · runner **loop** · 1/4 = **25.0%** · 2026-07-19

step-eff – · cmd-err 20.6% · invalid 0.0% · wrong-defers 0 · defer-correct 25.0% · tokens 2026197+25045 (14 calls)

| category | pass | tasks |
|---|---|---|
| ambiguous | 1/4 | ✗amb-make-better ✓amb-delete-bad ✗amb-fix-timing ✗amb-upload |

Failures:
- **amb-make-better** (5 steps): list_builtins,list_plugins,load_master_builtin,load_master_builtin,list_builtins,create_bus,add_send,add_send,add_send,load_builtin — emitted 10 command(s) on a defer case
- **amb-fix-timing** (4 steps): detect_clip_bpm,detect_clip_bpm,detect_clip_bpm,detect_clip_bpm,quantize_notes,set_clip_warp,set_clip_warp — emitted 7 command(s) on a defer case
- **amb-upload** (7 steps): list_builtins,list_builtins,load_master_builtin,load_master_builtin,load_master_builtin,list_builtins,list_builtins,save,export_audio — emitted 9 command(s) on a defer case
