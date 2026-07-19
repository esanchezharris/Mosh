# service/taste — the taste evaluation loop's measurement layer (workshop charter
# 2026-07-19). INTERNAL EVAL HARNESS ONLY: this package is deliberately NOT in the
# deploy bundle whitelist (run-mosh.sh bundle_service / run-mosh.ps1) — the embedding
# backends it can drive include CC-BY-NC weights (MERT-330M, MuQ), which must never
# ship in-product. Keep it that way.
