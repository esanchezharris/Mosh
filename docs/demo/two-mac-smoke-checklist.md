# Two-Mac Smoke Checklist

Record each row as `pass`, `fail`, or `not run`. If a row is `not run`, write the exact missing device, network, or app-launch blocker.

| Step | Observable pass | Observable fail |
| --- | --- | --- |
| 1. Launch the same signed/local Mosh build on both Macs. | Both apps open from the same branch/build and show usable arrange views. | Either app fails to launch, opens a stale build, or requires repo-local state not present on the other Mac. |
| 2. Mac A creates a multiplayer room; Mac B joins it. | Mac A and Mac B show the same room code, peer names, and online roster. | Join fails, peer roster is missing/stale, or either Mac remains in single-player state. |
| 3. iPhone controller sends record through `set_transport` with `source:"phone_controller"`. | The receiving Mac enters record transport state, and the command log keeps the normal `set_transport` command with phone source metadata. | A phone-only command name appears, validation bypasses `MoshOps::execute`, or record state does not change. |
| 4. Mac A creates and commits a track with an audio clip; Mac B receives it. | Mac B shows the peer-created track, and audio either resolves locally or displays the existing clean pending state. | The receiver creates duplicate/broken tracks, loses clip structure, or reports an ambiguous missing-audio failure. |
| 5. Both transports move; each Mac sees the other peer playhead/presence update. | Remote playhead position, playing, and recording state update at human-visible poll cadence and clear after leave/offline. | Presence sticks after leave/offline, shows the local user as remote, or updates through a persisted edit/sync schema. |

Manual result:

```text
Step 1:
Step 2:
Step 3:
Step 4:
Step 5:
Blockers:
```
