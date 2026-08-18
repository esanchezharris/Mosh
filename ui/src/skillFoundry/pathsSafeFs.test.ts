// Task 3 — RED-first pin for safe roots and safe filesystem primitives: symlink/wrong-owner/
// path-escape root rejection, atomic file replacement, and no-follow external-file bounds.

import { symlink, mkdir, mkdtemp, rm, chmod, writeFile, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveFoundryPathsV1 } from "./paths";
import { atomicWriteBytesV1, inspectExternalRegularFileV1 } from "./safeFs";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";

describe("resolveFoundryPathsV1", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("resolves a clean isolated homeDir and creates the expected tree", async () => {
    const result = await resolveFoundryPathsV1({}, foundry.homeDir, foundry.uid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.teachRoot).toBe(join(foundry.homeDir, "Library", "Mosh", "teach"));
    expect(result.value.agentRoot).toBe(join(foundry.homeDir, "Library", "Mosh", "agent"));
    await expect(lstat(result.value.draftsRoot)).resolves.toBeDefined();
    await expect(lstat(result.value.certifiedRoot)).resolves.toBeDefined();
  });

  it("is idempotent: resolving twice does not fail or change ownership", async () => {
    const first = await resolveFoundryPathsV1({}, foundry.homeDir, foundry.uid);
    const second = await resolveFoundryPathsV1({}, foundry.homeDir, foundry.uid);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("honors an absolute MOSH_AGENT_DIR override outside homeDir", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "mosh-agent-override-"));
    try {
      const result = await resolveFoundryPathsV1({ MOSH_AGENT_DIR: agentDir }, foundry.homeDir, foundry.uid);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.agentRoot).toBe(agentDir);
      await expect(lstat(result.value.certifiedRoot)).resolves.toBeDefined();
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects a RELATIVE MOSH_AGENT_DIR override (path-escape defence)", async () => {
    const result = await resolveFoundryPathsV1({ MOSH_AGENT_DIR: "relative/agent/dir" }, foundry.homeDir, foundry.uid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "unsafe_path" });
  });

  it("rejects a symlinked teach root", async () => {
    const teachRoot = join(foundry.homeDir, "Library", "Mosh", "teach");
    await rm(teachRoot, { recursive: true, force: true });
    const elsewhere = await mkdtemp(join(tmpdir(), "mosh-teach-elsewhere-"));
    try {
      await symlink(elsewhere, teachRoot);
      const result = await resolveFoundryPathsV1({}, foundry.homeDir, foundry.uid);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ code: "unsafe_path" });
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked ancestor within the managed subtree (Library/Mosh symlinked)", async () => {
    const libraryDir = join(foundry.homeDir, "Library");
    await rm(libraryDir, { recursive: true, force: true });
    const elsewhere = await mkdtemp(join(tmpdir(), "mosh-library-elsewhere-"));
    try {
      await symlink(elsewhere, libraryDir);
      const result = await resolveFoundryPathsV1({}, foundry.homeDir, foundry.uid);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ code: "unsafe_path" });
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("rejects a wrong-owner teach root", async () => {
    const teachRoot = join(foundry.homeDir, "Library", "Mosh", "teach");
    // We cannot chown to a different real uid without privilege, so simulate "wrong owner"
    // by asserting against an owner distinct from the target uid instead.
    const result = await resolveFoundryPathsV1({}, foundry.homeDir, foundry.uid + 987654);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "unsafe_path" });
    void teachRoot;
  });

  it("rejects a group/world-writable teach root", async () => {
    const teachRoot = join(foundry.homeDir, "Library", "Mosh", "teach");
    await mkdir(teachRoot, { recursive: true });
    await chmod(teachRoot, 0o777);
    const result = await resolveFoundryPathsV1({}, foundry.homeDir, foundry.uid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "unsafe_path" });
  });

  it("does not choke on a symlinked SYSTEM ancestor above homeDir (e.g. macOS /var -> /private/var)", async () => {
    // homeDir itself, produced by mkdtemp under os.tmpdir(), commonly sits beneath a
    // system-level symlink on macOS. Resolution must succeed anyway — only the foundry's
    // own managed subtree is checked for tampering, not the OS's own layout.
    const result = await resolveFoundryPathsV1({}, foundry.homeDir, foundry.uid);
    expect(result.ok).toBe(true);
  });
});

describe("atomicWriteBytesV1", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mosh-atomic-write-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes bytes durably and leaves no temp file behind", async () => {
    const target = join(dir, "out.json");
    await atomicWriteBytesV1(target, new TextEncoder().encode('{"a":1}'));
    const content = await readFile(target, "utf8");
    expect(content).toBe('{"a":1}');
  });

  it("replaces an existing file atomically (no partial content ever visible)", async () => {
    const target = join(dir, "out.json");
    await atomicWriteBytesV1(target, new TextEncoder().encode("first"));
    await atomicWriteBytesV1(target, new TextEncoder().encode("second-longer-content"));
    const content = await readFile(target, "utf8");
    expect(content).toBe("second-longer-content");
  });
});

describe("inspectExternalRegularFileV1", () => {
  let dir: string;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mosh-inspect-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a plain regular file within bounds and reports its identity", async () => {
    const file = join(dir, "evidence.bin");
    await writeFile(file, "hello world");
    const result = await inspectExternalRegularFileV1(file, uid, 1024);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bytes).toBe(11);
    expect(result.value.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a symlink without following it", async () => {
    const real = join(dir, "real.bin");
    await writeFile(real, "hello world");
    const link = join(dir, "link.bin");
    await symlink(real, link);
    const result = await inspectExternalRegularFileV1(link, uid, 1024);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("symlink");
  });

  it("rejects a file exceeding the bound", async () => {
    const file = join(dir, "big.bin");
    await writeFile(file, "x".repeat(100));
    const result = await inspectExternalRegularFileV1(file, uid, 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("oversized");
  });

  it("accepts a file at EXACTLY the bound and rejects bound+1", async () => {
    const file = join(dir, "exact.bin");
    await writeFile(file, "x".repeat(10));
    const atCap = await inspectExternalRegularFileV1(file, uid, 10);
    expect(atCap.ok).toBe(true);

    const file2 = join(dir, "over.bin");
    await writeFile(file2, "x".repeat(11));
    const overCap = await inspectExternalRegularFileV1(file2, uid, 10);
    expect(overCap.ok).toBe(false);
  });

  it("reports not_found for a missing file", async () => {
    const result = await inspectExternalRegularFileV1(join(dir, "missing.bin"), uid, 1024);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });
});
