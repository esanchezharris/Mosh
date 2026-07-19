# MoshAgentBench — amb-probe-01-ambiguity-gate

model `claude-sonnet-5` @ `claude-cli(subscription)` · runner **loop** · 3/4 = **75.0%** · 2026-07-19

step-eff – · cmd-err 12.5% · invalid 0.0% · wrong-defers 0 · defer-correct 75.0% · tokens 918429+19975 (7 calls)

| category | pass | tasks |
|---|---|---|
| ambiguous | 3/4 | ✓amb-make-better ✓amb-delete-bad ✓amb-fix-timing ✗amb-upload |

Failures:
- **amb-upload** (4 steps): list_builtins,list_builtins,load_master_builtin,load_master_builtin,load_master_builtin,list_builtins — emitted 6 command(s) on a defer case
