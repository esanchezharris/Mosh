# AUD-001 — root cause found: a `ReverseRenderJob` use-after-free, not the message-loop pumps

_2026-07-19. Supersedes the mechanism in
[`2026-07-18-selftest-sigsegv-reproduction-and-diagnosis.md`](2026-07-18-selftest-sigsegv-reproduction-and-diagnosis.md).
Reproduction + diagnosis are the deliverable; **no fix shipped**._

## The crash

Six ASan captures today, **all identical**:

```
ERROR: AddressSanitizer: heap-use-after-free
READ of size 1 ... thread T10/T11          <- a ThreadPool worker
    #0 juce::ThreadPool::pickNextJobToRun()        juce_ThreadPool.cpp:360
    #1 juce::ThreadPool::runNextJob(...)           juce_ThreadPool.cpp:382

freed by thread T0:                                 <- the message thread
    #1 tracktion::engine::RenderManager::handleAsyncUpdate()
    #2 RenderManager::Job::decReferenceCountWithoutDeleting()
    #3 RenderManager::Job::handleMessage(juce::Message const&)
    #4 juce::MessageQueue::deliverNextMessage()

previously allocated by:
    #1 tracktion::engine::ReverseRenderJob::getOrCreateRenderJob(...)
    #2 WaveAudioClip::getRenderJob(const AudioFile&)
    #3 AudioClipBase::renderSource()
    #4 AudioClipBase::updateSourceFile()
    #5 AudioClipBase::updateReversedState()
    #6 AudioClipBase::valueTreePropertyChanged(...)
```

**The message thread deletes a `RenderManager::Job` while a ThreadPool worker is
traversing the job list and reading it.** A genuine lifetime race, upstream in
Tracktion.

## The causal chain

1. `set_clip_reverse` → `cmdSetClipReverse` (`MoshOps.cpp:4218`) → `ac->setIsReversed(...)`.
2. That ValueTree property change fires `AudioClipBase::updateReversedState` →
   `renderSource` → `getRenderJob` → a **`ReverseRenderJob`** queued on RenderManager's
   ThreadPool.
3. The Job is refcounted. On T0, `Job::handleMessage` → `decReferenceCountWithoutDeleting`
   → `RenderManager::handleAsyncUpdate` **deletes** it.
4. Concurrently a pool worker is inside `ThreadPool::pickNextJobToRun()` walking the job
   array — and reads the freed object.
5. Concurrency widens the window: ~10% of runs under 5-way load.

`set_clip_reverse` landed in the **2026-07-18 clip-ops window (#417)** and is exercised
3× by `--selftest`. That matches the previous diagnosis's own bracketing exactly — a
Jul-16 build was clean over 6 serial runs, so the regression is *after* 2026-07-16.

## Two hypotheses falsified BY MEASUREMENT

Both were plausible, and both were wrong. This is the part worth keeping.

### 1. `AudioFileManager::handleAsyncUpdate` heap-buffer-overflow — NOT this crash

The 07-18 diagnosis captured that stack, and it *is* a real latent bug:
`getUnchecked(filesToCheck.size() - 1)` with an empty array reads `values[-1]`, and the
producer is asymmetric (`addIfNotAlreadyThere` conditional, `triggerAsyncUpdate`
unconditional). PR #448 hardens it and is worth having on its own merits.

But it is a **different error class** (buffer-overflow vs use-after-free), on a
**different thread** (T0 vs a pool worker), in a **different subsystem**. Every crash
reproduced today was the `ReverseRenderJob` UAF. Fixing the OOB does not address AUD-001.

### 2. The mid-transaction message-loop pumps — NOT causal

Three controlled arms, unpatched engine throughout, ASan + 5-way concurrency:

| arm | `MoshOps` pumps | free observed under | ASan reports |
|---|---|---|---|
| A | all present | `runDispatchLoopUntil` ← `importWaveFileToTrack` | 1/10 |
| B | `importWaveFileToTrack` removed | `runDispatchLoopUntil` ← **`createAudioTrack`** | 1/20 |
| C | **9 cargo-cult pumps removed** | the **normal CFRunLoop** (no pump) | **4/30** |

Removing one pump moved the crash to the next pump; removing nine moved it to the
ordinary message loop. **The rate did not go to zero.** The pumps change *when* the
`RenderManager::Job` message is delivered, which is why the original capture had a pump
in the stack — but they are not the cause.

(A 1/10 → 1/20 → 4/30 sequence is **not** a trend. At these counts the rates are
statistically indistinguishable; the load-bearing fact is only that C ≠ 0.)

### What the pump audit DID establish

Worth keeping even though it isn't the fix: **9 of the 11 `MoshOps` pumps are
cargo-cult**, and removing them is **check-count-neutral** — `--selftest` returns
**1790/1790, 0 failed, 0 asserts**, byte-identical to the control with them present.

Their stated rationale is provably false: `EditItem` assigns `itemID` in its constructor
member-init list (`tracktion_EditItem.cpp:20`) and `insertWaveClip` assigns one *before*
insertion, so nothing downstream needs a drain. The codebase already documents the
correct rule at `MoshOps.cpp:3160` (`cmdApplyRemoteTrack`), which declines to drain and
explains why.

Two of the eleven are genuinely load-bearing (`cmdAssignSample`, `loadDrumKitInto`) and
were left alone. Two of the nine are **unguarded and user-reachable** — `cmdStopRecording`
(pumps ×4 straight after a recording lands) and `applyAudioDeviceSetup`. The 07-18
diagnosis was right about that; a later claim that `cmdStopRecording` is guarded was
wrong.

The removal diff is parked at
`~/Library/Mosh/parked/aud-001-pump-removal-hygiene.patch`. It is **hygiene, not a fix**,
and should never be sold as one.

## Reproduction — the durable asset

`scripts/verify-hardware/asan-concurrency-repro.sh`. Needs Release-ish + ASan +
concurrency; **plain Release + concurrency does not reproduce** (unpatched control was
**0/15**, i.e. no detection power — do not use it to validate a fix).

```bash
cmake -S . -B build-asan -G Ninja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF \
  -DCMAKE_CXX_FLAGS="-fsanitize=address -fno-omit-frame-pointer" \
  -DCMAKE_C_FLAGS="-fsanitize=address -fno-omit-frame-pointer" \
  -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=address" -DMOSH_BUILD_TESTS=OFF \
  -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache \
  -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src
cmake --build build-asan --target Mosh

scripts/verify-hardware/asan-concurrency-repro.sh \
  build-asan/Mosh_artefacts/RelWithDebInfo/Mosh.app/Contents/MacOS/Mosh mylabel 6
```

**Statistical power matters here.** At ~10%, three clean runs prove almost nothing —
p(3 clean | no change) ≈ 0.73. Distinguishing "fixed" from "unchanged" needs ~30+ runs
per arm, and distinguishing 10% from 5% needs far more than that.

## Candidate fixes — none attempted

1. **Upstream `RenderManager::Job` lifetime.** The real fix. `decReferenceCountWithoutDeleting`
   + deletion from `handleAsyncUpdate` must not race `ThreadPool::pickNextJobToRun`.
   Needs someone to read RenderManager's refcounting properly — do **not** guess.
2. **Join before teardown.** Ensure outstanding render jobs are finished/removed from the
   pool before the objects can be freed.
3. **Sidestep in headless.** Have `set_clip_reverse` avoid kicking a background render
   when there is no audio device. Narrowest, but it hides the bug rather than fixing it.

## The lesson

The 07-18 diagnosis was credible, specific, and had an ASan trace — and I built a fix on
it without reproducing it first. That trace was of a different instance than the one that
actually reproduces. **Reproduce before fixing, even when a good diagnosis already
exists**; and when a fix is cheap, the temptation to skip the repro is strongest exactly
when it is most likely to mislead.
