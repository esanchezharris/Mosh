import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const markerName = ".mosh-harness-owned-v1";
const markerContents = "Mosh isolated harness session v1";
let cachedInstallId: string | null = null;

function identityDirectory(env: Record<string, string>, appDataRoot: string): string | null {
  const leaf = (env.MOSH_SELFTEST_SESSION || "").trim();
  if (!leaf) return join(appDataRoot, "session");

  const harness = resolve(appDataRoot, "_harness");
  const candidate = resolve(appDataRoot, leaf);
  const rel = relative(harness, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) return null;

  for (let current = candidate; current !== appDataRoot; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return null;
    if (dirname(current) === current) return null;
  }

  const marker = join(candidate, markerName);
  try {
    if (!lstatSync(candidate).isDirectory() || lstatSync(marker).isSymbolicLink()) return null;
    if (readFileSync(marker, "utf-8") !== markerContents) return null;
  } catch {
    return null;
  }
  return candidate;
}

export function installId(
  env: Record<string, string>,
  appDataRoot = join(homedir(), "Library", "Mosh"),
): string {
  if (env.MOSH_BRAIN_INSTALL_ID) return env.MOSH_BRAIN_INSTALL_ID;
  if (cachedInstallId) return cachedInstallId;
  const dir = identityDirectory(env, resolve(appDataRoot));
  const fresh = randomUUID();
  if (!dir) {
    cachedInstallId = fresh;
    return fresh;
  }

  const file = join(dir, "identity.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof parsed === "object" && parsed !== null && "uuid" in parsed) {
      const uuid = (parsed as { uuid?: unknown }).uuid;
      if (typeof uuid === "string" && uuid) {
        cachedInstallId = uuid;
        return uuid;
      }
    }
  } catch {
  }

  try {
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ uuid: fresh }));
    }
  } catch {
  }
  cachedInstallId = fresh;
  return fresh;
}

export function resetInstallIdCacheForTests(): void {
  cachedInstallId = null;
}
