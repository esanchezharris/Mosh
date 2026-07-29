# MoshAgentBench — dn-r5

model `claude-sonnet-5` @ `claude-cli(subscription)` · runner **single** · 2/3 = **66.7%** · 2026-07-28

step-eff 100.0% · cmd-err 33.3% · invalid 0.0% · wrong-defers 0 · defer-correct – · tokens 155472+1587 (3 calls)

| category | pass | tasks |
|---|---|---|
| master | 2/3 | ✓master-glue ✗master-eq-before-comp ✓master-trim |

Failures:
- **master-eq-before-comp** (1 steps): load_master_builtin — master ~"eq" missing (chain: Compressor); master chain missing "eq"
