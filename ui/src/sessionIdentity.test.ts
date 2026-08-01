import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installId, resetInstallIdCacheForTests } from "./sessionIdentity";

const owned = "Mosh isolated harness session v1";

afterEach(() => resetInstallIdCacheForTests());

describe("Vite brain identity session isolation", () => {
  it("persists and reuses identity only in a marker-owned harness session", () => {
    const root = mkdtempSync(join(tmpdir(), "mosh-vite-identity-"));
    const dir = join(root, "_harness", "vite-owned");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".mosh-harness-owned-v1"), owned);

    const first = installId({ MOSH_SELFTEST_SESSION: "_harness/vite-owned" }, root);
    resetInstallIdCacheForTests();
    const second = installId({ MOSH_SELFTEST_SESSION: "_harness/vite-owned" }, root);

    expect(second).toBe(first);
    expect(JSON.parse(readFileSync(join(dir, "identity.json"), "utf-8")).uuid).toBe(first);
  });

  it("returns an ephemeral id without writing through traversal or unowned sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "mosh-vite-identity-root-"));
    const outside = mkdtempSync(join(tmpdir(), "mosh-vite-identity-outside-"));
    const unowned = join(root, "_harness", "unowned");
    mkdirSync(unowned, { recursive: true });
    writeFileSync(join(unowned, "keep.txt"), "owner data");
    writeFileSync(join(root, ".mosh-harness-owned-v1"), owned);

    expect(installId({ MOSH_SELFTEST_SESSION: "_harness/.." }, root)).not.toBe("");
    expect(() => readFileSync(join(root, "identity.json"), "utf-8")).toThrow();
    resetInstallIdCacheForTests();
    expect(installId({ MOSH_SELFTEST_SESSION: outside }, root)).not.toBe("");
    expect(readFileSync(join(unowned, "keep.txt"), "utf-8")).toBe("owner data");
    expect(() => readFileSync(join(outside, "identity.json"), "utf-8")).toThrow();
    resetInstallIdCacheForTests();
    expect(installId({ MOSH_SELFTEST_SESSION: "_harness/unowned" }, root)).not.toBe("");
    expect(() => readFileSync(join(unowned, "identity.json"), "utf-8")).toThrow();
  });
});
