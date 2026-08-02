import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOwnerEnvironment, readOwnerOpenAIKey } from "../src/owner-env.js";

const temporaryDirectories: string[] = [];

function ownerEnv(contents: string, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "mosh-owner-env-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "env");
  writeFileSync(filePath, contents, { mode });
  chmodSync(filePath, mode);
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("owner OpenAI credential loading", () => {
  it("prefers an inherited key without reading the owner file", () => {
    expect(readOwnerOpenAIKey(
      { OPENAI_API_KEY: " inherited-key " },
      join(tmpdir(), "missing-mosh-owner-env"),
    )).toBe("inherited-key");
  });

  it("loads the existing owner key from a mode-600 env file", () => {
    const filePath = ownerEnv(`
      # Owner-only credentials
      OPENAI_API_KEY="reused-owner-key"
    `);
    expect(readOwnerOpenAIKey({}, filePath)).toBe("reused-owner-key");
  });

  it("loads the export form used by the existing owner env file", () => {
    const filePath = ownerEnv("export OPENAI_API_KEY='reused-exported-owner-key'\n");
    expect(readOwnerOpenAIKey({}, filePath)).toBe("reused-exported-owner-key");
  });

  it("refuses a credential file readable by group or other users", () => {
    const filePath = ownerEnv("OPENAI_API_KEY=unsafe-owner-key\n", 0o644);
    expect(readOwnerOpenAIKey({}, filePath)).toBeUndefined();
  });

  it("loads owner orchestration settings while inherited values win", () => {
    const filePath = ownerEnv(`
      MOSH_PLAYTEST_EVIDENCE_URL=https://edge.invalid/from-file
      MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET=file-secret
      ignored-lowercase=value
    `);
    expect(readOwnerEnvironment({ MOSH_PLAYTEST_EVIDENCE_URL: "https://edge.invalid/inherited" }, filePath))
      .toMatchObject({
        MOSH_PLAYTEST_EVIDENCE_URL: "https://edge.invalid/inherited",
        MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET: "file-secret",
      });
  });
});
