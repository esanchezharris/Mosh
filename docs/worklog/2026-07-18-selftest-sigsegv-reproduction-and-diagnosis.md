# AUD-001 — the intermittent `--selftest` crash: reproduced and diagnosed

_2026-07-18. Investigation record. **No fix shipped** — the diagnosis is the deliverable._

## Symptom

`main`'s native gate goes red intermittently: `--selftest` exits `rc=139` (SIGSEGV) on
some runs. CI runs `29642891241` (`363724d2`, `nonzero_exit: r1:rc=139 r2:rc=139`) and
`29670046869` (`961a3454`, `checks [1656,-1,1656]`, `r2:rc=139`).

## Reproduction (this is the useful part)

It needs **Release _and_ concurrency**. Neither alone reproduces it.

| build | mode | result |
|---|---|---|
| Jul-16 deployed Release | serial ×6 | clean → brackets the regression to **after 2026-07-16** |
| Debug + ASan | serial ×3 | clean |
| Debug + ASan | 5-way concurrent | clean (0 crashes; 2 unrelated undo-assert failures — see AUD-016) |
| **Release + ASan** | serial ×3 | clean |
| **Release + ASan** | **5-way concurrent** | **2 of 5 crash with an ASan report** |

```bash
cmake -S . -B build-macos-arm64-relasan -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DMOSH_SANITIZE=address -DMOSH_BUILD_TESTS=OFF -DMOSH_BUILD_PLUGIN_FIXTURES=OFF \
  -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache \
  -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src
cmake --build build-macos-arm64-relasan --target Mosh

export ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:print_stacktrace=1:symbolize=1"
# 5 concurrent runs, ISOLATED session dirs (this is not the SLF-CONC-001 shared-dir bug)
for i in 1 2 3 4 5; do
  ( MOSH_SELFTEST_SESSION="rac-$i" MOSH_SERVICE_PORT=$((9010+i)) \
      .../Mosh --selftest -ApplePersistenceIgnoreState YES > c$i.log 2>&1 ) &
done; wait
```

That "Release + load" combination is exactly what a CI runner is, which is why it reds
there and not on a dev Mac.

> **The LTO+ASan link needs a lot of memory** and was OOM-killed on the first attempt.
> The objects survive — just re-run `cmake --build` and the link picks up where it stopped.

## The report

```
ERROR: AddressSanitizer: heap-buffer-overflow ... READ of size 8 at ... thread T0
  #0 tracktion::engine::AudioFileManager::handleAsyncUpdate()
  #1 juce::AsyncUpdater::AsyncUpdaterMessage::messageCallback()
  #2 juce::MessageQueue::runLoopCallback()
  ...
  #16 juce::MessageManager::runDispatchLoopUntil(int)
  #17 mosh::MoshOps::importWaveFileToTrack(...)
  #18 mosh::MoshOps::cmdImportClip(...)
  #19 mosh::MoshOps::cmdAddTestTone(...)
  #20 mosh::MoshOps::executeImpl(...)
```

(The "freed by thread T3 / allocated by T0" blocks name a libdispatch `Block`. That is
ASan attributing to the *nearest* chunk — the faulting address is 64 bytes past a
40-byte region — so treat it as noise, not the culprit.)

## Diagnosis

`MoshOps::importWaveFileToTrack` **pumps a nested message loop while its own undo
transaction is open**:

```cpp
beginTxn (command);
...
auto clip = track->insertWaveClip (...);
// "drain it before returning so itemIDs settle"
if (! eng.hasAudio())
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (1);
```

Pumping the loop runs **arbitrary queued async work re-entrantly**, in the middle of a
half-finished Tracktion mutation — including `AudioFileManager::handleAsyncUpdate()`,
which ASan catches reading out of bounds. Under load there is more queued when the pump
fires, which is why concurrency is required to see it.

**There are 12 `runDispatchLoopUntil` sites in `src/moshops/MoshOps.cpp`** and 4 more in
`MoshEngine.cpp`. This is a pattern, not a one-off.

## Why it does not affect the shipped app

Every one of these pumps is guarded by `if (! eng.hasAudio())` — **headless only**. The
GUI app has an audio device and never takes this path. So the cost is a **red CI gate and
an untrustworthy harness**, not a user-facing crash. That should inform how much risk the
fix is worth.

## Why no fix here

The Iron Law: the fix touches the single mutation path at 12 sites, and "stop pumping the
message loop mid-transaction" needs a real design (defer the drain to after `endTxn`? let
itemIDs settle without a pump? accept re-entrancy and make it safe?). Landing a guess in
`MoshOps` to quiet a headless-only crash is a bad trade. The reproduction above makes the
next attempt cheap — start there, not from scratch.
