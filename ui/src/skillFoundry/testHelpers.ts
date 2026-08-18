// Task 3 — shared test isolation helper. NEVER read or write the owner's real
// `~/Library/Mosh/teach` or `$MOSH_AGENT_DIR`: every test roots both trees under a fresh
// `mkdtemp` directory, which is also its own trust anchor (owned by the test-runner uid,
// mode 0700 from `mkdtemp` itself) so `resolveFoundryPathsV1`'s safety checks pass without
// weakening them for tests.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FoundryPathsV1 } from "./contracts";
import { resolveFoundryPathsV1 } from "./paths";

export type IsolatedFoundryV1 = {
  homeDir: string;
  paths: FoundryPathsV1;
  uid: number;
  cleanup: () => Promise<void>;
};

export type CreateIsolatedFoundryOptionsV1 = {
  /** Pass an absolute path OUTSIDE `homeDir` to exercise the `MOSH_AGENT_DIR` override path. */
  agentDir?: string;
};

/** A fresh, isolated `{teachRoot, agentRoot}` pair for exactly one test. */
export async function createIsolatedFoundryV1(options: CreateIsolatedFoundryOptionsV1 = {}): Promise<IsolatedFoundryV1> {
  const homeDir = await mkdtemp(join(tmpdir(), "mosh-teach-test-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.agentDir !== undefined) {
    env.MOSH_AGENT_DIR = options.agentDir;
  } else {
    delete env.MOSH_AGENT_DIR;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const result = await resolveFoundryPathsV1(env, homeDir, uid);
  if (!result.ok) {
    throw new Error(`failed to resolve isolated foundry paths: ${result.error.path}: ${result.error.reason}`);
  }
  return {
    homeDir,
    paths: result.value,
    uid,
    cleanup: async () => {
      await rm(homeDir, { recursive: true, force: true });
      if (options.agentDir !== undefined) {
        await rm(options.agentDir, { recursive: true, force: true });
      }
    },
  };
}
