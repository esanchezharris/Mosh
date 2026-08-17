// Slice D — `teach-moshi` process entrypoint.
//
// Task 1: `mainV1` is dependency-injected and side-effect-free apart from one stdout write
// and setting `process.exitCode` — it never calls `process.exit`, so a test can drive it
// without killing the test runner. The bottom-of-file guard invokes it with real `process`
// state only when this module is the process entrypoint (`tsx src/skillFoundry/cli.ts`),
// never on import (e.g. from cli.test.ts).

import { createStubTeachMoshiDepsV1, runTeachMoshiV1 } from "./commands";
import type { TeachMoshiDepsV1 } from "./contracts";

export async function mainV1(argv: readonly string[], deps: TeachMoshiDepsV1): Promise<void> {
  const { exitCode, envelope } = await runTeachMoshiV1(argv, deps);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = exitCode;
}

const isEntrypoint =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  void mainV1(process.argv.slice(2), createStubTeachMoshiDepsV1());
}
