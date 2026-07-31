import { spawn } from "node:child_process";

export type CommandEnvironment = Readonly<Record<string, string>>;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface CommandRunner {
  run(command: string, args: readonly string[], cwd?: string): Promise<CommandResult>;
}

export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw codedError("github_invalid_response", "Command returned invalid JSON");
  }
}

const baseEnvironmentKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "__CF_USER_TEXT_ENCODING",
] as const;

const githubEnvironmentKeys = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "GH_PROMPT_DISABLED",
  "GH_NO_UPDATE_NOTIFIER",
  "SSH_AUTH_SOCK",
] as const;

function selectedEnvironment(
  source: NodeJS.ProcessEnv,
  keys: readonly string[],
): CommandEnvironment {
  return Object.freeze(Object.fromEntries(keys.flatMap((key) => {
    const value = source[key];
    return typeof value === "string" ? [[key, value]] : [];
  })));
}

export function githubCommandEnvironment(
  source: NodeJS.ProcessEnv,
): CommandEnvironment {
  return selectedEnvironment(source, [...baseEnvironmentKeys, ...githubEnvironmentKeys]);
}

export function localGitCommandEnvironment(
  source: NodeJS.ProcessEnv,
): CommandEnvironment {
  return selectedEnvironment(source, baseEnvironmentKeys);
}

export function repairHelperCommandEnvironment(
  source: NodeJS.ProcessEnv,
): CommandEnvironment {
  return selectedEnvironment(source, baseEnvironmentKeys);
}

export class NodeCommandRunner implements CommandRunner {
  private readonly environment: CommandEnvironment;

  constructor(environment: CommandEnvironment) {
    this.environment = Object.freeze({ ...environment });
  }

  async run(command: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        ...(cwd ? { cwd } : {}),
        env: this.environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 2_000_000) stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 100_000) stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  }
}
