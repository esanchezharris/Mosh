#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
ClaudeMosh live-audio loopback is intentionally not automated in this consolidation pass.

Rationale:
- The JamPilot source script changes CoreAudio default devices, system volume, and app settings.
- The preservation pass must finish before any live-audio experiment changes machine state.

Required safeguards for the future gate:
- Capture default input/output/system-output device IDs before changes.
- Capture and restore output/input/alert volume and mute state.
- Write all WAV/JSON/log evidence under _preserved_artifacts/.../live-audio/.
- Trap EXIT/INT/TERM and restore CoreAudio settings before exiting.
- Keep plugin-host/editor proof separate from export/offline-render proof.
EOF
