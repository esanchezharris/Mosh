import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NativeRepairArtifactPolicy } from "../src/repair-artifact-policy.js";

const SOURCE_SHA = "a".repeat(40);

async function artifacts() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "mosh-repair-artifacts-")));
  const worktree = path.join(root, "worktree");
  const evidence = path.join(worktree, "evidence");
  const bundlePath = path.join(evidence, "repair-bundle");
  const buildPath = path.join(worktree, "build", "Mosh.app");
  const contents = path.join(buildPath, "Contents");
  const executableDirectory = path.join(contents, "MacOS");
  await mkdir(bundlePath, { recursive: true });
  await mkdir(executableDirectory, { recursive: true });
  const redEvidencePath = path.join(evidence, "red.log");
  const greenEvidencePath = path.join(evidence, "green.log");
  const diagnosticsPath = path.join(evidence, "diagnostics.log");
  await Promise.all([
    writeFile(redEvidencePath, "red"),
    writeFile(greenEvidencePath, "green"),
    writeFile(diagnosticsPath, "diagnostics"),
    writeFile(
      path.join(contents, "Info.plist"),
      "<?xml version=\"1.0\"?><plist><dict><key>CFBundleIdentifier</key><string>studio.mosh.app</string></dict></plist>",
    ),
    writeFile(path.join(executableDirectory, "Mosh"), Buffer.from(`binary:${SOURCE_SHA}:end`)),
  ]);
  return {
    root,
    worktree,
    result: {
      redEvidencePath,
      greenEvidencePath,
      diagnosticsPath,
      bundlePath,
      buildPath,
      sourceSha: SOURCE_SHA,
      draftPrUrl: "https://github.invalid/pull/9",
      draft: true as const,
      merged: false as const,
    },
  };
}

describe("repair artifact path policy", () => {
  it("canonicalizes an existing in-worktree Mosh bundle whose executable embeds sourceSha", async () => {
    const fixture = await artifacts();
    const policy = new NativeRepairArtifactPolicy();

    await expect(policy.validateResult(fixture.worktree, fixture.result)).resolves.toEqual(fixture.result);
  });

  it("rejects outsider and lexical traversal paths", async () => {
    const fixture = await artifacts();
    const policy = new NativeRepairArtifactPolicy();
    const outsider = path.join(fixture.root, "outsider.log");
    await writeFile(outsider, "outside");

    await expect(policy.validateResult(fixture.worktree, {
      ...fixture.result,
      redEvidencePath: outsider,
    })).rejects.toMatchObject({ code: "repair_artifact_path" });
    await expect(policy.validateResult(fixture.worktree, {
      ...fixture.result,
      redEvidencePath: `${fixture.worktree}/evidence/../evidence/red.log`,
    })).rejects.toMatchObject({ code: "repair_artifact_path" });
  });

  it("rejects symlinked evidence, wrong bundle identity, and source mismatch", async () => {
    const fixture = await artifacts();
    const policy = new NativeRepairArtifactPolicy();
    const symlinkPath = path.join(fixture.worktree, "evidence", "red-link.log");
    await symlink(fixture.result.redEvidencePath, symlinkPath);

    await expect(policy.validateResult(fixture.worktree, {
      ...fixture.result,
      redEvidencePath: symlinkPath,
    })).rejects.toMatchObject({ code: "repair_artifact_symlink" });

    await writeFile(
      path.join(fixture.result.buildPath, "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>evil.app</string></dict></plist>",
    );
    await expect(policy.validateResult(fixture.worktree, fixture.result))
      .rejects.toMatchObject({ code: "repair_bundle_id" });

    const sourceFixture = await artifacts();
    await expect(policy.validateResult(sourceFixture.worktree, {
      ...sourceFixture.result,
      sourceSha: "b".repeat(40),
    })).rejects.toMatchObject({ code: "repair_source_mismatch" });
  });
});
