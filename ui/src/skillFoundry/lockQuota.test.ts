// Task 3 — RED-first pin for the ownership-bound lock and quota traversal: concurrent lock
// contention, stale-lock reclaim, and exact/max+1 quota boundaries.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOUNDRY_STORAGE_LIMITS_V1 } from "./contracts";
import { FoundryLockContentionError, withFoundryLockV1 } from "./lock";
import { assertQuotaMutationV1, measureFoundryQuotaV1 } from "./quota";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";

describe("withFoundryLockV1", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("runs the callback and releases the lock afterward", async () => {
    let ran = false;
    await withFoundryLockV1(foundry.paths.lockPath, "status", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    // A second acquisition must succeed immediately, proving release happened.
    let ranAgain = false;
    await withFoundryLockV1(foundry.paths.lockPath, "status", async () => {
      ranAgain = true;
    });
    expect(ranAgain).toBe(true);
  });

  it("rejects a concurrent acquisition held by a LIVE process (this one)", async () => {
    // Simulate a live concurrent holder by acquiring for real and then, from INSIDE the
    // held lock, attempting a second acquisition — the second attempt sees our own live
    // pid/identity and must fail closed as contention, never silently proceed.
    await expect(
      withFoundryLockV1(foundry.paths.lockPath, "outer", async () => {
        await withFoundryLockV1(foundry.paths.lockPath, "inner", async () => {
          throw new Error("must not run: nested acquisition should have thrown first");
        });
      }),
    ).rejects.toBeInstanceOf(FoundryLockContentionError);
  });

  it("reclaims a STALE lock (dead pid) and proceeds", async () => {
    const readProcessStartIdentity = async (pid: number): Promise<string | null> => {
      // Every pid reports as dead except a sentinel "still alive" pid we never use here.
      void pid;
      return null;
    };
    let ran = false;
    await withFoundryLockV1(
      foundry.paths.lockPath,
      "outer-stale",
      async () => {
        // Leave the lock directory in place by not releasing normally: we simulate this by
        // directly seeding a stale lock directory before acquiring for real below instead.
      },
      { readProcessStartIdentity },
    );
    // Seed a hand-crafted stale lock (an old pid/identity that will never match "alive").
    await mkdir(foundry.paths.lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(foundry.paths.lockPath, "metadata.json"),
      JSON.stringify({
        schemaVersion: 1,
        nonce: "stale-nonce",
        pid: 999999,
        processStartIdentity: "definitely-not-current",
        command: "certify",
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    await withFoundryLockV1(
      foundry.paths.lockPath,
      "reclaimer",
      async () => {
        ran = true;
      },
      { readProcessStartIdentity: async () => null },
    );
    expect(ran).toBe(true);
  });

  it("releases even when the callback throws", async () => {
    await expect(
      withFoundryLockV1(foundry.paths.lockPath, "boom", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    let ranAfter = false;
    await withFoundryLockV1(foundry.paths.lockPath, "after-boom", async () => {
      ranAfter = true;
    });
    expect(ranAfter).toBe(true);
  });
});

describe("measureFoundryQuotaV1 / assertQuotaMutationV1", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("measures zero usage on a fresh foundry", async () => {
    const snapshot = await measureFoundryQuotaV1(foundry.paths);
    expect(snapshot).toEqual({ draftCount: 0, draftBytesById: {}, allDraftBytes: 0, allRunArtifactBytes: 0 });
  });

  it("counts one draft directory and its file bytes", async () => {
    const draftDir = join(foundry.paths.draftsRoot, "owner-x");
    await mkdir(draftDir, { recursive: true });
    await writeFile(join(draftDir, "request.json"), "x".repeat(100));
    const snapshot = await measureFoundryQuotaV1(foundry.paths);
    expect(snapshot.draftCount).toBe(1);
    expect(snapshot.draftBytesById["owner-x"]).toBe(100);
    expect(snapshot.allDraftBytes).toBe(100);
  });

  it("allows a mutation landing EXACTLY at the draft-count cap", () => {
    const snapshot = { draftCount: FOUNDRY_STORAGE_LIMITS_V1.maxDrafts - 1, draftBytesById: {}, allDraftBytes: 0, allRunArtifactBytes: 0 };
    expect(() => assertQuotaMutationV1(snapshot, { newDraft: true })).not.toThrow();
  });

  it("rejects a mutation that would exceed the draft-count cap by one", () => {
    const snapshot = { draftCount: FOUNDRY_STORAGE_LIMITS_V1.maxDrafts, draftBytesById: {}, allDraftBytes: 0, allRunArtifactBytes: 0 };
    expect(() => assertQuotaMutationV1(snapshot, { newDraft: true })).toThrowError(/quota/i);
  });

  it("allows a per-draft byte delta landing EXACTLY at the per-draft cap", () => {
    const snapshot = { draftCount: 1, draftBytesById: { "owner-x": 0 }, allDraftBytes: 0, allRunArtifactBytes: 0 };
    expect(() =>
      assertQuotaMutationV1(snapshot, { draftId: "owner-x", draftBytesDelta: FOUNDRY_STORAGE_LIMITS_V1.maxDraftBytes }),
    ).not.toThrow();
  });

  it("rejects a per-draft byte delta exceeding the per-draft cap by one byte", () => {
    const snapshot = { draftCount: 1, draftBytesById: { "owner-x": 0 }, allDraftBytes: 0, allRunArtifactBytes: 0 };
    expect(() =>
      assertQuotaMutationV1(snapshot, { draftId: "owner-x", draftBytesDelta: FOUNDRY_STORAGE_LIMITS_V1.maxDraftBytes + 1 }),
    ).toThrowError(/quota/i);
  });

  it("rejects a run-artifact byte delta exceeding the all-run-artifacts cap", () => {
    const snapshot = { draftCount: 0, draftBytesById: {}, allDraftBytes: 0, allRunArtifactBytes: FOUNDRY_STORAGE_LIMITS_V1.maxAllRunArtifactBytes };
    expect(() => assertQuotaMutationV1(snapshot, { runArtifactBytesDelta: 1 })).toThrowError(/quota/i);
  });

  it("deletes nothing when a quota assertion fails (root-cap exhaustion blocks, never deletes)", async () => {
    const draftDir = join(foundry.paths.draftsRoot, "owner-x");
    await mkdir(draftDir, { recursive: true });
    await writeFile(join(draftDir, "request.json"), "kept");
    const snapshot = await measureFoundryQuotaV1(foundry.paths);
    expect(() =>
      assertQuotaMutationV1(
        { ...snapshot, allDraftBytes: FOUNDRY_STORAGE_LIMITS_V1.maxAllDraftBytes },
        { draftId: "owner-x", draftBytesDelta: 1 },
      ),
    ).toThrowError(/quota/i);
    const stillThere = await measureFoundryQuotaV1(foundry.paths);
    expect(stillThere.draftBytesById["owner-x"]).toBe(4);
  });
});
