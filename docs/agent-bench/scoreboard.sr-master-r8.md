# MoshAgentBench — sr-master-r8

model `claude-sonnet-5` @ `claude-cli(subscription)` · runner **single** · 1/3 = **33.3%** · 2026-07-28

step-eff 100.0% · cmd-err 66.7% · invalid 0.0% · wrong-defers 0 · defer-correct – · tokens 328197+3767 (3 calls)

| category | pass | tasks |
|---|---|---|
| master | 1/3 | ✗master-glue ✗master-eq-before-comp ✓master-trim |

Failures:
- **master-glue** (1 steps): load_master_builtin,set_master_plugin_param,set_master_plugin_param,set_master_plugin_param,set_master_plugin_param — master ~"comp" missing (chain: empty)
- **master-eq-before-comp** (1 steps): load_master_builtin — master ~"eq" missing (chain: Compressor); master chain missing "eq"
