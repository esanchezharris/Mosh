import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { RepairJob } from "./contracts.js";
import { failure } from "./orchestration-types.js";

type RepairResult = NonNullable<RepairJob["result"]>;

async function canonicalDescendant(
  recordedWorktree: string,
  candidate: string,
  kind: "file" | "directory",
): Promise<string> {
  if (!path.isAbsolute(candidate) || candidate.split(path.sep).includes("..")) {
    throw failure("repair_artifact_path", "Repair artifact path is not an absolute descendant");
  }
  const worktree = await realpath(recordedWorktree);
  if (path.resolve(recordedWorktree) !== worktree) {
    throw failure("repair_worktree_path", "Recorded repair worktree is not canonical");
  }
  const relative = path.relative(worktree, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw failure("repair_artifact_path", "Repair artifact is outside its recorded worktree");
  }
  let current = worktree;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw failure("repair_artifact_symlink", "Repair artifact path contains a symbolic link");
    }
  }
  const canonical = await realpath(candidate);
  if (canonical !== path.resolve(candidate)) {
    throw failure("repair_artifact_path", "Repair artifact path is not canonical");
  }
  const stats = await lstat(canonical);
  if ((kind === "file" && !stats.isFile()) || (kind === "directory" && !stats.isDirectory())) {
    throw failure("repair_artifact_type", `Repair artifact must be a ${kind}`);
  }
  return canonical;
}

async function validateBuild(
  worktreePath: string,
  buildPath: string,
  sourceSha: string,
): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw failure("repair_source_sha", "Repair source SHA is invalid");
  }
  const app = await canonicalDescendant(worktreePath, buildPath, "directory");
  if (!app.endsWith(".app")) {
    throw failure("repair_build_bundle", "Repair build must be a macOS app bundle");
  }
  const plist = await canonicalDescendant(worktreePath, path.join(app, "Contents", "Info.plist"), "file");
  const executable = await canonicalDescendant(
    worktreePath,
    path.join(app, "Contents", "MacOS", "Mosh"),
    "file",
  );
  const plistText = await readFile(plist, "utf8");
  if (!/<key>CFBundleIdentifier<\/key>\s*<string>studio\.mosh\.app<\/string>/.test(plistText)) {
    throw failure("repair_bundle_id", "Repair build has the wrong bundle identifier");
  }
  if (!(await readFile(executable)).includes(Buffer.from(sourceSha))) {
    throw failure("repair_source_mismatch", "Repair executable does not embed its source SHA");
  }
  return app;
}

export class NativeRepairArtifactPolicy {
  async validateResult(worktreePath: string, result: RepairResult): Promise<RepairResult> {
    const [redEvidencePath, greenEvidencePath, diagnosticsPath, bundlePath, buildPath] =
      await Promise.all([
        canonicalDescendant(worktreePath, result.redEvidencePath, "file"),
        canonicalDescendant(worktreePath, result.greenEvidencePath, "file"),
        canonicalDescendant(worktreePath, result.diagnosticsPath, "file"),
        canonicalDescendant(worktreePath, result.bundlePath, "directory"),
        validateBuild(worktreePath, result.buildPath, result.sourceSha),
      ]);
    return {
      ...result,
      redEvidencePath,
      greenEvidencePath,
      diagnosticsPath,
      bundlePath,
      buildPath,
    };
  }

  validateBuild(worktreePath: string, buildPath: string, sourceSha: string): Promise<string> {
    return validateBuild(worktreePath, buildPath, sourceSha);
  }
}
