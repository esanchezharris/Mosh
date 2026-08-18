// Task 5 — RED-first pin for reference locators: 32/33 references per draft, 4 GiB/+1
// external-file bound (proven at the boundary logic level, not by writing 4 GiB), and
// valid/invalid `AbletonReferenceV1`.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOUNDRY_STORAGE_LIMITS_V1 } from "./contracts";
import { addReferenceV1, parseAbletonReferenceV1, revalidateReferenceV1 } from "./references";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";

const CLOCK = { now: () => new Date("2026-01-01T00:00:00.000Z") };

describe("addReferenceV1 / revalidateReferenceV1", () => {
  let foundry: IsolatedFoundryV1;
  let draftDir: string;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
    draftDir = join(foundry.paths.draftsRoot, "owner-park-backgrounds");
    await mkdir(join(draftDir, "references"), { recursive: true });
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("stores a locator without copying the external file", async () => {
    const filePath = join(foundry.homeDir, "evidence.wav");
    await writeFile(filePath, "fake audio bytes");
    const result = await addReferenceV1({ draftDir, filePath, uid, clock: CLOCK });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locator.absolutePath).toBe(filePath);
    expect(result.locator.bytes).toBe(Buffer.byteLength("fake audio bytes"));
    // The referenced file's own bytes must never be duplicated under the draft directory.
    const { readdir } = await import("node:fs/promises");
    const referenceFiles = await readdir(join(draftDir, "references"));
    expect(referenceFiles).toHaveLength(1);
    expect(referenceFiles[0]).toMatch(/\.json$/);
  });

  it("is idempotent on re-adding the same path", async () => {
    const filePath = join(foundry.homeDir, "evidence.wav");
    await writeFile(filePath, "fake audio bytes");
    await addReferenceV1({ draftDir, filePath, uid, clock: CLOCK });
    const second = await addReferenceV1({ draftDir, filePath, uid, clock: CLOCK });
    expect(second).toMatchObject({ ok: true, changed: false });
  });

  it("rejects a symlinked external file", async () => {
    const realPath = join(foundry.homeDir, "real.wav");
    await writeFile(realPath, "real bytes");
    const linkPath = join(foundry.homeDir, "link.wav");
    const { symlink } = await import("node:fs/promises");
    await symlink(realPath, linkPath);
    const result = await addReferenceV1({ draftDir, filePath: linkPath, uid, clock: CLOCK });
    expect(result.ok).toBe(false);
  });

  it("accepts exactly 32 references and rejects the 33rd", async () => {
    for (let i = 0; i < FOUNDRY_STORAGE_LIMITS_V1.maxReferencesPerDraft; i += 1) {
      const filePath = join(foundry.homeDir, `evidence-${i}.wav`);
      await writeFile(filePath, `bytes-${i}`);
      const result = await addReferenceV1({ draftDir, filePath, uid, clock: CLOCK });
      expect(result.ok).toBe(true);
    }
    const overCap = join(foundry.homeDir, "evidence-over.wav");
    await writeFile(overCap, "over");
    const result = await addReferenceV1({ draftDir, filePath: overCap, uid, clock: CLOCK });
    expect(result).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("revalidateReferenceV1 passes when the file is unchanged and fails when it has changed", async () => {
    const filePath = join(foundry.homeDir, "evidence.wav");
    await writeFile(filePath, "original bytes");
    const added = await addReferenceV1({ draftDir, filePath, uid, clock: CLOCK });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const stillOk = await revalidateReferenceV1(added.locator, uid);
    expect(stillOk).toEqual({ ok: true });

    await writeFile(filePath, "MUTATED bytes, different content and length");
    const nowChanged = await revalidateReferenceV1(added.locator, uid);
    expect(nowChanged).toMatchObject({ ok: false, code: "changed" });
  });

  it("revalidateReferenceV1 catches a symlink swapped in after recording", async () => {
    const filePath = join(foundry.homeDir, "evidence.wav");
    await writeFile(filePath, "original bytes");
    const added = await addReferenceV1({ draftDir, filePath, uid, clock: CLOCK });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const { rm, symlink, writeFile: wf } = await import("node:fs/promises");
    await rm(filePath);
    const decoy = join(foundry.homeDir, "decoy.wav");
    await wf(decoy, "decoy content");
    await symlink(decoy, filePath);

    const result = await revalidateReferenceV1(added.locator, uid);
    expect(result.ok).toBe(false);
  });
});

describe("parseAbletonReferenceV1", () => {
  function validReference() {
    return {
      schemaVersion: 1,
      journeyId: "session-control",
      liveVersion: "12.1",
      startedAt: "2026-01-01T00:00:00.000Z",
      goal: "Play, stop, save",
      checkpoints: [
        { name: "start", narration: "press play", unobservedOrAmbiguous: [] },
      ],
      ownerRules: { variables: ["track name"], forbidden: ["deleting a track"] },
    };
  }

  it("accepts a minimal valid reference", () => {
    const result = parseAbletonReferenceV1(validReference());
    expect(result.ok).toBe(true);
  });

  it("accepts optional beforeSet/afterSet with a valid hash", () => {
    const withSets = {
      ...validReference(),
      beforeSet: { path: "/tmp/before.als", sha256: "a".repeat(64) },
      afterSet: { path: "/tmp/after.als", sha256: "b".repeat(64) },
    };
    expect(parseAbletonReferenceV1(withSets).ok).toBe(true);
  });

  it("rejects a malformed beforeSet (bad hash length)", () => {
    const bad = { ...validReference(), beforeSet: { path: "/tmp/before.als", sha256: "not-hex" } };
    expect(parseAbletonReferenceV1(bad).ok).toBe(false);
  });

  it("rejects a missing journeyId", () => {
    const bad = { ...validReference(), journeyId: "" };
    expect(parseAbletonReferenceV1(bad).ok).toBe(false);
  });

  it("rejects a non-object value", () => {
    expect(parseAbletonReferenceV1(null).ok).toBe(false);
    expect(parseAbletonReferenceV1("a string").ok).toBe(false);
  });

  it("rejects malformed checkpoints", () => {
    const bad = { ...validReference(), checkpoints: [{ name: "x" }] };
    expect(parseAbletonReferenceV1(bad).ok).toBe(false);
  });
});
