// Slice D — `teach-moshi` process entrypoint.
//
// Task 1: `mainV1` is dependency-injected and side-effect-free apart from one stdout write
// and setting `process.exitCode` — it never calls `process.exit`, so a test can drive it
// without killing the test runner. The bottom-of-file guard invokes it with real `process`
// state only when this module is the process entrypoint (`tsx src/skillFoundry/cli.ts`),
// never on import (e.g. from cli.test.ts).
//
// Task 10: the real entrypoint wires `createRealTeachMoshiDepsV1()`, which resolves the
// OWNER'S actual foundry paths — never used by tests, which always construct their own
// `TeachMoshiDepsV1` (or an isolated-paths real one) and call `mainV1`/`runTeachMoshiV1`
// directly instead of exercising this module-load guard.

import { createRealTeachMoshiDepsV1, runTeachMoshiV1 } from "./commands";
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
  createRealTeachMoshiDepsV1()
    .then((deps) => mainV1(process.argv.slice(2), deps))
    .catch((err) => {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          ok: false,
          command: process.argv[2] ?? "",
          error: { code: "unsafe_path", message: err instanceof Error ? err.message : String(err), details: {} },
        })}\n`,
      );
      process.exitCode = 1;
    });
}
