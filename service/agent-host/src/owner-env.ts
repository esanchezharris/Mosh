import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parseValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === `"` || first === `'`) && trimmed.at(-1) === first)
      return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

export function readOwnerOpenAIKey(
  environment: NodeJS.ProcessEnv = process.env,
  filePath = join(homedir(), ".config", "mosh", "env"),
): string | undefined {
  return readOwnerEnvironment(environment, filePath).OPENAI_API_KEY?.trim() || undefined;
}

export function readOwnerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  filePath = join(homedir(), ".config", "mosh", "env"),
): NodeJS.ProcessEnv {
  const fromFile: NodeJS.ProcessEnv = {};

  try {
    const metadata = statSync(filePath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) return { ...environment };
    for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = line.replace(/^export\s+/, "");
      const separator = assignment.indexOf("=");
      if (separator < 1) continue;
      const name = assignment.slice(0, separator).trim();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
      const value = parseValue(assignment.slice(separator + 1));
      if (value) fromFile[name] = value;
    }
  } catch {
    return { ...environment };
  }
  return { ...fromFile, ...environment };
}
