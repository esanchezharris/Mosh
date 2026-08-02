import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const capability = "startup-smoke-capability";
const dataDirectory = await mkdtemp(path.join(tmpdir(), "mosh-agent-host-startup-"));
const child = spawn("npm", ["run", "dev"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    OPENAI_API_KEY: "",
    MOSH_AGENT_HOST_CAPABILITY: capability,
    MOSH_AGENT_HOST_DATA_DIR: dataDirectory,
    PORT: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

try {
  let startupTimer;
  const startup = await Promise.race([
    new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const candidate = JSON.parse(line);
          if (candidate.type === "mosh.agent-host.ready") resolve(candidate);
        } catch {
          // npm's own script banner is not the host envelope.
        }
      });
      child.once("exit", (code) => reject(new Error(`Agent host exited before ready (${code}): ${stderr.join("")}`)));
    }),
    new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(new Error("Agent host startup timed out")), 10_000);
      startupTimer.unref();
    }),
  ]);
  clearTimeout(startupTimer);
  assert.equal(startup.host, "127.0.0.1");
  assert.equal(startup.capability, capability);
  assert.ok(Number.isInteger(startup.port) && startup.port > 0);

  const health = await fetch(`http://127.0.0.1:${startup.port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ready", version: 1 });
  const unauthorized = await fetch(`http://127.0.0.1:${startup.port}/v1/playtests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`http://127.0.0.1:${startup.port}/v1/playtests`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${capability}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(authorized.status, 201);
  process.stdout.write(`${JSON.stringify({
    startup: "passed",
    host: startup.host,
    dynamicPort: true,
    healthStatus: health.status,
    unauthorizedStatus: unauthorized.status,
    authorizedStatus: authorized.status,
    openAIConfigured: false,
  })}\n`);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
