# Mosh Re-Imagine VST3 — owner acceptance

This is an Apple-silicon, owner-local VST3 effect. It does not install during a
normal Mosh build and it does not modify Ableton clips.

## Build and install

```sh
cmake --preset macos-arm64-debug -DMOSH_BUILD_REIMAGINE_PLUGIN=ON
cmake --build build-macos-arm64 --target MoshReImaginePlugin_VST3 MoshReImagineBundleSmoke -j 6
ctest --test-dir build-macos-arm64 -R MoshReImagineBundleSmoke --output-on-failure
scripts/install-owner-reimagine-plugin.sh build-macos-arm64 Debug
```

The installer writes only:

- `~/Library/Audio/Plug-Ins/VST3/Mosh Re-Imagine.vst3`
- `~/Library/Application Support/Mosh/ReImagine/service`

Source and render WAVs are content-addressed under
`~/Library/Mosh/ReImagine/assets`. They are never automatically deleted.

## Recorded owner host evidence

On 2026-08-23 the owner installer completed successfully from the Debug arm64
bundle. The installed VST3 retained bundle ID `studio.mosh.reimagine`, passed a
strict deep code-signature verification, and the shared helper was staged at the
path above. Ableton Live 11.3.43 discovered **Mosh Re-Imagine** during startup,
showed it in the browser, and instantiated it in a fresh Untitled Set. Live's
`Log.txt` recorded both `plugin processor successfully loaded` and
`Created: Mosh Re-Imagine`.

This proves installation, discovery, and processor instantiation. The audio-track
Transfer and by-ear steps below remain open; the smoke instance was placed on a
MIDI track and the audio engine was intentionally left off.

## Live 11 by-ear gate

1. Rescan VST3 plug-ins and insert **Mosh Re-Imagine** on an audio track.
   Installation, discovery, and processor instantiation are proven above; the
   audio-track insertion remains part of the listening pass.
2. While stopped, click **Transfer**, play a known passage, then stop Live.
3. Enter a prompt or change the rack. Confirm the source remains dry until the
   render is ready, then the selected take replaces only the transferred range.
4. Audition three Colors and a known owner LoRA; confirm each audibly changes a
   fresh take. Make several fast edits and confirm only the newest pending
   revision becomes a take.
5. Seek, loop, automate tempo, and export offline. Confirm discontinuous
   Transfers abort, captured tempo automation aligns, divergent tempo passes
   dry, and export never starts inference.
6. Save/reopen the Set. Confirm take metadata restores and audio loads
   asynchronously. Temporarily move a render asset; reopen and confirm a visible
   missing-asset status with dry playback.
7. Open Mosh and Live together. Confirm both adopt the same port recorded at
   `~/Library/Application Support/Mosh/ReImagine/service.port` and neither client
   terminates the helper. Confirm the helper exits after its bounded idle window.
8. Confirm the owner SA3 release policy unloads the approximately 9.2 GB model,
   then judge A/B usefulness on physical output by ear.

Distribution remains out of scope until Stability AI licensing is reviewed.
