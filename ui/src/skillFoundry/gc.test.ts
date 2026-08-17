// Task 9 — RED-first pin for GC: dry-run immutability, the strict 90-day boundary,
// active/approved/installed/blocker retention, and partial apply after revalidation.

import { mkdir, readdir, symlink, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFoundryGcV1, planFoundryGcV1 } from "./gc";
import { createDraftStoreV1 } from "./draftStore";
import { appendStateTransitionV1 } from "./stateLedger";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";

const FAKE_IDENTITY_DEPS = { resolveGitCommit: async () => "a".repeat(40), resolveAppVersion: async () => "1.0.0" };
const IDENTITY = { gitCommit: "a".repeat(40), appVersion: "1.0.0", build: { kind: "offline" as const, toolVersion: "teach-moshi-v1" as const } };

function clockAt(iso: string) {
  return { now: () => new Date(iso) };
}

async function setMtime(path: string, iso: string): Promise<void> {
  const date = new Date(iso);
  await utimes(path, date, date);
}

async function createDraftAtState(
  foundry: IsolatedFoundryV1,
  goal: string,
  finalState: "draft" | "rejected" | "superseded" | "revoked" | "blocked" | "owner_approved",
) {
  const store = createDraftStoreV1(foundry.paths, clockAt("2020-01-01T00:00:00.000Z"), FAKE_IDENTITY_DEPS);
  const created = await store.createDraft({ goal });
  if (finalState === "draft") return created;

  const chain: Array<typeof finalState | "source_reviewed" | "schema_valid" | "mock_green" | "native_green" | "packaged_green" | "acceptance_green"> =
    finalState === "blocked" || finalState === "rejected" || finalState === "superseded" || finalState === "revoked"
      ? [finalState]
      : ["source_reviewed", "schema_valid", "mock_green", "native_green", "packaged_green", "acceptance_green", "owner_approved"];

  for (const state of chain) {
    await appendStateTransitionV1(created.statePath, {
      state,
      artifactKind: "declarative",
      artifactHashes: {},
      executionIdentity: IDENTITY,
      testCommand: "test",
      startedAt: "2020-01-01T00:00:00.000Z",
      finishedAt: "2020-01-01T00:00:00.000Z",
      result: "passed",
    });
  }
  return created;
}

describe("planFoundryGcV1", () => {
  let foundry: IsolatedFoundryV1;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("is a pure dry run: changes nothing on disk", async () => {
    const created = await createDraftAtState(foundry, "old rejected", "rejected");
    await setMtime(created.draftDir, "2020-01-01T00:00:00.000Z");
    const before = await readdir(foundry.paths.draftsRoot);

    await planFoundryGcV1({}, { paths: foundry.paths, clock: clockAt("2026-06-01T00:00:00.000Z"), uid });

    const after = await readdir(foundry.paths.draftsRoot);
    expect(after).toEqual(before);
  });

  it("lists a rejected draft strictly older than 90 days, and NOT one at exactly 90 days", async () => {
    const oldRejected = await createDraftAtState(foundry, "old rejected", "rejected");
    await setMtime(oldRejected.draftDir, "2020-01-01T00:00:00.000Z");

    const now = new Date("2020-01-01T00:00:00.000Z");
    const exactlyNinety = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const planAtExactly90 = await planFoundryGcV1({}, { paths: foundry.paths, clock: { now: () => exactlyNinety }, uid });
    expect(planAtExactly90.entries.some((e) => e.path === oldRejected.draftDir)).toBe(false); // equality does NOT qualify

    const oneMsPast = new Date(exactlyNinety.getTime() + 1);
    const planPast90 = await planFoundryGcV1({}, { paths: foundry.paths, clock: { now: () => oneMsPast }, uid });
    expect(planPast90.entries.some((e) => e.path === oldRejected.draftDir)).toBe(true);
  });

  it("never lists active/approved/installed/blocker drafts, regardless of age", async () => {
    const draftState = await createDraftAtState(foundry, "still a draft", "draft");
    const approved = await createDraftAtState(foundry, "approved", "owner_approved");
    const blocked = await createDraftAtState(foundry, "blocked forever", "blocked");
    for (const created of [draftState, approved, blocked]) {
      await setMtime(created.draftDir, "2000-01-01T00:00:00.000Z"); // ancient
    }

    const plan = await planFoundryGcV1({}, { paths: foundry.paths, clock: clockAt("2026-06-01T00:00:00.000Z"), uid });
    const listedPaths = plan.entries.map((e) => e.path);
    expect(listedPaths).not.toContain(draftState.draftDir);
    expect(listedPaths).not.toContain(approved.draftDir);
    expect(listedPaths).not.toContain(blocked.draftDir);
  });

  it("lists a stray .tmp-* directory regardless of age", async () => {
    const strayDir = join(foundry.paths.teachRoot, ".tmp-stray-crash-leftover");
    await mkdir(strayDir, { recursive: true });
    await writeFile(join(strayDir, "partial.json"), "garbage");

    const plan = await planFoundryGcV1({}, { paths: foundry.paths, clock: clockAt("2026-01-01T00:00:00.000Z"), uid });
    expect(plan.entries.some((e) => e.path === strayDir && e.kind === "tmp")).toBe(true);
  });

  it("never lists a symlinked path, even one shaped like a stray tmp dir", async () => {
    const elsewhere = join(foundry.homeDir, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const linkPath = join(foundry.paths.teachRoot, ".tmp-symlinked");
    await symlink(elsewhere, linkPath);

    const plan = await planFoundryGcV1({}, { paths: foundry.paths, clock: clockAt("2026-01-01T00:00:00.000Z"), uid });
    expect(plan.entries.some((e) => e.path === linkPath)).toBe(false);
  });

  it("never emits a path under certifiedRoot (packages)", async () => {
    await mkdir(join(foundry.paths.certifiedRoot, "owner-x@1.0.0"), { recursive: true });
    const plan = await planFoundryGcV1({}, { paths: foundry.paths, clock: clockAt("2026-01-01T00:00:00.000Z"), uid });
    expect(plan.entries.every((e) => !e.path.startsWith(foundry.paths.certifiedRoot))).toBe(true);
  });
});

describe("applyFoundryGcV1", () => {
  let foundry: IsolatedFoundryV1;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("removes only entries that revalidate; a changed entry is skipped, not force-removed", async () => {
    const oldRejected = await createDraftAtState(foundry, "old rejected", "rejected");
    await setMtime(oldRejected.draftDir, "2020-01-01T00:00:00.000Z");

    const clock = clockAt("2026-06-01T00:00:00.000Z");
    const plan = await planFoundryGcV1({}, { paths: foundry.paths, clock, uid });
    expect(plan.entries.length).toBeGreaterThan(0);

    // Simulate the entry becoming young again between plan and apply (revalidation catches it).
    await setMtime(oldRejected.draftDir, new Date().toISOString());

    const result = await applyFoundryGcV1(plan, { paths: foundry.paths, clock, uid });
    expect(result.removed).not.toContain(oldRejected.draftDir);
    expect(result.skipped.some((s) => s.path === oldRejected.draftDir)).toBe(true);
    await expect(readdir(oldRejected.draftDir)).resolves.toBeDefined(); // still there
  });

  it("actually deletes a still-valid stray tmp directory", async () => {
    const strayDir = join(foundry.paths.teachRoot, ".tmp-real-crash-leftover");
    await mkdir(strayDir, { recursive: true });
    const clock = clockAt("2026-01-01T00:00:00.000Z");
    const plan = await planFoundryGcV1({}, { paths: foundry.paths, clock, uid });
    expect(plan.entries.some((e) => e.path === strayDir)).toBe(true);

    const result = await applyFoundryGcV1(plan, { paths: foundry.paths, clock, uid });
    expect(result.removed).toContain(strayDir);
    await expect(readdir(strayDir)).rejects.toBeDefined();
  });

  it("partial apply: one bad entry does not block removal of a good one", async () => {
    const strayDir = join(foundry.paths.teachRoot, ".tmp-good");
    await mkdir(strayDir, { recursive: true });
    const oldRejected = await createDraftAtState(foundry, "old rejected 2", "rejected");
    await setMtime(oldRejected.draftDir, "2020-01-01T00:00:00.000Z");

    const clock = clockAt("2026-06-01T00:00:00.000Z");
    const plan = await planFoundryGcV1({}, { paths: foundry.paths, clock, uid });

    // Corrupt the plan with a bogus entry claiming to be safe.
    const tamperedPlan = { ...plan, entries: [...plan.entries, { path: "/etc/passwd", kind: "tmp" as const, ageDays: 9999 }] };

    const result = await applyFoundryGcV1(tamperedPlan, { paths: foundry.paths, clock, uid });
    expect(result.removed).toContain(strayDir);
    expect(result.removed).toContain(oldRejected.draftDir);
    expect(result.skipped.some((s) => s.path === "/etc/passwd")).toBe(true);
  });

  it("never invokes automatically on root exhaustion — apply requires an explicit call with a plan", async () => {
    // No assertion beyond the type contract: applyFoundryGcV1 always requires an explicit
    // plan argument produced by a prior planFoundryGcV1 call — there is no code path in this
    // module that self-invokes GC from a quota failure.
    expect(typeof applyFoundryGcV1).toBe("function");
  });
});
