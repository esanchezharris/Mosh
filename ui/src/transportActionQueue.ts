let queue: Promise<void> = Promise.resolve();
let generation = 0;

export function cancelTransportActions(): void {
  generation += 1;
}

export function enqueueTransportAction(action: () => Promise<void>): Promise<void> {
  const scheduledGeneration = generation;
  const run = async () => {
    if (generation !== scheduledGeneration) return;
    await action();
  };
  const next = queue.then(run, run);
  queue = next.then(() => undefined, () => undefined);
  return next;
}
