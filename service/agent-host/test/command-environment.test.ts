import { describe, expect, it } from "vitest";
import {
  githubCommandEnvironment,
  localGitCommandEnvironment,
  NodeCommandRunner,
  repairHelperCommandEnvironment,
} from "../src/command-runner.js";

const hostileEnvironment: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/owner",
  TMPDIR: "/private/tmp",
  LANG: "en_US.UTF-8",
  LC_CTYPE: "UTF-8",
  __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
  SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
  GH_TOKEN: "gh-owned-token",
  GITHUB_TOKEN: "github-owned-token",
  GH_ENTERPRISE_TOKEN: "gh-enterprise-owned-token",
  GITHUB_ENTERPRISE_TOKEN: "github-enterprise-owned-token",
  GH_HOST: "github.example",
  GH_CONFIG_DIR: "/Users/owner/.config/gh",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  OPENAI_API_KEY: "sk-openai-must-not-spawn",
  MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET: "evidence-must-not-spawn",
  SUPABASE_SERVICE_ROLE_KEY: "supabase-must-not-spawn",
  ANTHROPIC_API_KEY: "anthropic-must-not-spawn",
  AWS_SECRET_ACCESS_KEY: "aws-must-not-spawn",
  GIT_ASKPASS: "/Users/owner/hostile-askpass",
  GIT_SSH_COMMAND: "ssh -o ProxyCommand=hostile",
};

function parsedEnvironment(stdout: string): Record<string, string> {
  return Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

describe("production command child environments", () => {
  it.each([
    {
      adapter: "gh",
      build: githubCommandEnvironment,
      expected: {
        GH_TOKEN: "gh-owned-token",
        GITHUB_TOKEN: "github-owned-token",
        GH_ENTERPRISE_TOKEN: "gh-enterprise-owned-token",
        GITHUB_ENTERPRISE_TOKEN: "github-enterprise-owned-token",
        GH_HOST: "github.example",
        GH_CONFIG_DIR: "/Users/owner/.config/gh",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
      },
    },
    {
      adapter: "local git",
      build: localGitCommandEnvironment,
      expected: {},
    },
    {
      adapter: "repair helper",
      build: repairHelperCommandEnvironment,
      expected: {},
    },
  ])("gives $adapter only its explicit allowlist at the real spawn boundary", async ({
    build,
    expected,
  }) => {
    const runner = new NodeCommandRunner(build(hostileEnvironment));
    const result = await runner.run("/usr/bin/env", []);
    const childEnvironment = parsedEnvironment(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(childEnvironment).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/owner",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
      ...expected,
    });
    expect(childEnvironment).not.toHaveProperty("OPENAI_API_KEY");
    expect(childEnvironment).not.toHaveProperty("MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET");
    expect(childEnvironment).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(childEnvironment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(childEnvironment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(childEnvironment).not.toHaveProperty("GIT_ASKPASS");
    expect(childEnvironment).not.toHaveProperty("GIT_SSH_COMMAND");
  });
});
