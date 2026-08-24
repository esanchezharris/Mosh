# Ableton Live 11 parity ledger

Live 11 parity status: NOT PROVEN

This is the readable view of `live11-parity.json`. The JSON ledger and
`live11-reference-manifest.json` are the fail-closed source of truth. Browser
tests, generic DAW conformance, and a plausible screenshot are useful evidence,
but none proves installed-app parity by itself.

## Current verdict

Mosh is **not** at Ableton Live 11 parity. The exact-size baseline comparison
differs across essentially the entire frame. The arrangement-grid repair is a
candidate because its focused geometry, edge matrix, and independent visual
reviews pass; it remains short of verified until exact-SHA installed-app proof
and owner-file rollback evidence land.

| Required surface | Status | Highest-signal open gap |
|---|---|---|
| Global chrome and transport | unproven | Geometry and installed transport timing have no Live 11 differential. |
| Arrangement grid and rulers | candidate | Exact-SHA installed-app proof remains. |
| Track headers and mixer | unproven | Full measured state matrix and native outcomes are missing. |
| Clips, automation, and take lanes | unproven | Automation lanes and Live 11 drag/comp semantics remain open. |
| Browser, devices, and plug-ins | unproven | The browser is visibly different; paired instrument flow is missing. |
| MIDI editor | unproven | No canonical Live 11 editor reference or native note/audio differential. |
| Audio and device workflow | unproven | Physical behavior is not yet attached to exact-SHA parity evidence. |
| Core producer flows | unproven | No paired create-edit-play-save-reopen-render workflow. |

## Bounded repair wave

Only the arrangement grid is active. Global layout measurement and the
browser/device instrument flow are queued, so the program never exceeds three
active repairs. Each row in the JSON ledger carries its scenario, tolerance,
automated gate, manual gate, and owner-safety boundary.

## Validation

Run:

```sh
python3 scripts/live11-parity/validate.py \
  --expected-source-sha d3bbe3ad314af02d38bdeffc297101043a71d019
python3 -m unittest scripts/live11-parity/test_validate.py
```

The validator rejects nonexistent or wrong handoff revisions, missing reference
hashes or metadata, missing local reference pixels, hash drift, absent
required-surface rows, stale verified artifacts, unsupported parity claims,
more than three active repairs, and contradictory documentation. Proprietary
Live captures remain owner-local and gitignored; only their hashes and capture
metadata are committed.

## Continuation

After the active grid repair is installed and verified, checkpoint its goal and
continue the durable loop with:

```sh
node ~/.codex/plugins/cache/sisyphuslabs/omo/4.19.4/components/ulw-loop/dist/cli.js ulw-loop complete-goals --session-id live11-parity-20260823
```
