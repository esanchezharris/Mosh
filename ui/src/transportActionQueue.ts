let queue: Promise<void> = Promise.resolve();
let generation = 0;

export function cancelTransportActions(): void {
  generation += 1;
}

// Skill Foundry Slice B, Task 2 — widened to generic `<T>` (was `Promise<void>`) so a
// queued action's resolved value (e.g. store.ts's RecordingStoreOutcomeV1) survives the
// queue instead of being discarded. Every existing `() => Promise<void>` caller is
// unaffected — T infers to void exactly as before. A cancelled generation (the project
// changed mid-queue) resolves to `undefined`, matching the old behavior for void callers;
// a caller relying on a real value from a cancelled action gets `undefined` there too,
// which every current caller already treats as "the action did not observably run".
export function enqueueTransportAction<T>(action: () => Promise<T>): Promise<T | undefined> {
  const scheduledGeneration = generation;
  const run = async (): Promise<T | undefined> => {
    if (generation !== scheduledGeneration) return undefined;
    return action();
  };
  const next = queue.then(run, run);
  queue = next.then(() => undefined, () => undefined);
  return next;
}
