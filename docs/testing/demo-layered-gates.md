# Demo Layered Gates

These gates prove the collaboration demo through the same native seams used by the app. Keep them additive and do not fork command schemas for phone, React, Moshi, or peer sync.

## Layer 0: Build

```sh
cmake --build build-macos-arm64 --target Mosh
cmake --build build-macos-arm64 --target MoshTests
```

Pass: both targets build without errors. Existing third-party warnings are not failures.

## Layer 1: MoshOps ValueTree Golden

```sh
MOSH_NO_AUDIO=1 MOSH_GOLDEN_DIR=tests/golden \
  build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --golden-selftest
```

Pass: `Layer 1: create_track ValueTree golden` reports fixture match for `moshop_create_track.xml`.

Failure: inspect the `.actual.xml` file written beside the selftest session output. Never auto-update fixtures.

## Layer 2: Phone Command Conformance

```sh
ctest --test-dir build-macos-arm64 --output-on-failure
```

Pass: the phone-shaped body still extracts the standard `set_transport` command object and applies through `MoshOps::execute`.

Failure: fix routing at the remote/iOS command adapter. Do not add iPhone-only command names or validators.

## Layer 3: Peer Commit Golden

```sh
MOSH_NO_AUDIO=1 MOSH_GOLDEN_DIR=tests/golden \
  build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --golden-selftest
```

Pass: `Layer 3: peer apply committed track ValueTree golden` reports fixture match for `peer_apply_committed_track.xml`, and audio is either locally resolved or reported as the existing clean pending state.

## Layer 4: Remote Playhead UI

```sh
cd ui
npm test -- RemotePlayheads store
npm run build-storybook
```

Pass: the store preserves current online peer presence, clears on leave/offline, and Storybook builds the `Arrange/RemotePlayheads` fixture.

## Final Local Gate

```sh
MOSH_NO_AUDIO=1 MOSH_GOLDEN_DIR=tests/golden build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --golden-selftest
MOSH_NO_AUDIO=1 build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
MOSH_NO_AUDIO=1 build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest-undo
```

Run the final local gate three times before merge when time permits, and paste the tallies in the PR or commit notes.
