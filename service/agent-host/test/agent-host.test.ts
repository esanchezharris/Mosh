import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentInputItem, Session } from "@openai/agents-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceRecordSchema,
  RepairJobSchema,
  type SupervisorPlan,
} from "../src/contracts.js";
import {
  createHostedTraceRunner,
  SupervisorOutputJsonSchema,
  type RealtimeSecretAdapter,
  type SupervisorModelAdapter,
} from "../src/openai.js";
import { FileAgentSession, PlaytestStore } from "../src/persistence.js";
import { startAgentHost } from "../src/server.js";
import { AgentHostService } from "../src/service.js";

const capability = "test-launch-capability";
const auth = { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" };
const closing: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
});

class FakeSupervisor implements SupervisorModelAdapter {
  inputs: string[] = [];
  sessions: string[] = [];
  traces: Array<Record<string, string>> = [];

  constructor(readonly output: unknown) {}

  async run(input: string, session: Session, traceMetadata: Record<string, string>): Promise<unknown> {
    this.inputs.push(input);
    this.sessions.push(await session.getSessionId());
    this.traces.push(traceMetadata);
    return this.output;
  }
}

async function fixture(options: {
  supervisor?: SupervisorModelAdapter;
  realtime?: RealtimeSecretAdapter;
  dataDirectory?: string;
} = {}) {
  const dataDirectory = options.dataDirectory ?? await mkdtemp(path.join(tmpdir(), "mosh-agent-host-"));
  const service = new AgentHostService(
    new PlaytestStore(dataDirectory),
    options.supervisor,
    options.realtime,
  );
  const host = await startAgentHost({ service, capability });
  closing.push(host.close);
  return { ...host, service, dataDirectory };
}

async function post(
  origin: string,
  pathname: string,
  body: unknown,
  headers: Record<string, string> = auth,
) {
  return fetch(`${origin}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function createPlaytest(origin: string, retainTranscript = false) {
  const response = await post(origin, "/v1/playtests", { retainTranscript });
  expect(response.status).toBe(201);
  return await response.json() as { id: string };
}

function validTurn(playtestId: string) {
  return {
    playtestId,
    message: "Loop these bars",
    capabilitySchemas: [{
      id: "set_loop",
      description: "Set the timeline loop",
      inputSchema: { type: "object", properties: { start: { type: "number" } } },
    }],
    stateDigest: { playing: false },
    recentResults: [],
    conversationContext: [],
  };
}

const validPlan: SupervisorPlan = {
  intent: "Set a loop",
  say: "I can loop those bars.",
  commands: [{ capabilityId: "set_loop", arguments: { start: 1 } }],
  needsClarification: false,
  selectedCapabilityIds: ["set_loop"],
};

class ConcurrentSessionSupervisor implements SupervisorModelAdapter {
  active = 0;
  maximumActive = 0;

  async run(input: string, session: Session): Promise<unknown> {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    const message = (JSON.parse(input) as { message: string }).message;
    try {
      await session.addItems([
        { role: "user", content: message } as AgentInputItem,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await session.addItems([
        { role: "assistant", content: `reply:${message}` } as unknown as AgentInputItem,
      ]);
      return { ...validPlan, say: `reply:${message}` };
    } finally {
      this.active -= 1;
    }
  }
}

describe("local server security and health", () => {
  it("binds only to loopback, reports readiness, and rejects missing or wrong auth", async () => {
    const host = await fixture();
    expect(host.host).toBe("127.0.0.1");
    expect(host.port).toBeGreaterThan(0);

    const health = await fetch(`${host.origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ready", version: 1 });

    expect((await post(host.origin, "/v1/playtests", {}, { "Content-Type": "application/json" })).status).toBe(401);
    expect((await post(host.origin, "/v1/playtests", {}, {
      Authorization: "Bearer wrong",
      "Content-Type": "application/json",
    })).status).toBe(401);
  });
});

describe("contracts and persistence", () => {
  it("rejects malformed versioned records and API input", async () => {
    expect(() => EvidenceRecordSchema.parse({
      version: 2,
      id: crypto.randomUUID(),
      playtestId: crypto.randomUUID(),
      reportId: crypto.randomUUID(),
      kind: "screenshot",
      localPath: "/tmp/example.png",
      sha256: "not-a-sha",
      createdAt: new Date().toISOString(),
    })).toThrow();
    expect(() => RepairJobSchema.parse({ version: 1, status: "invented" })).toThrow();

    const host = await fixture();
    const playtest = await createPlaytest(host.origin);
    const invalidReport = await post(host.origin, "/v1/reports", {
      playtestId: playtest.id,
      kind: "invented",
      title: "",
      body: "Invalid",
    });
    expect(invalidReport.status).toBe(400);
    expect((await invalidReport.json() as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("recovers atomically replaced session snapshots after restart", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "mosh-agent-host-restart-"));
    const first = await fixture({ dataDirectory });
    const created = await createPlaytest(first.origin);
    await first.close();
    closing.pop();

    const restartedStore = new PlaytestStore(dataDirectory);
    await restartedStore.initialize();
    const recovered = await restartedStore.loadSession(created.id);
    expect(recovered.id).toBe(created.id);
    expect(recovered.status).toBe("active");
    await expect(stat(path.join(dataDirectory, "sessions", created.id, "session.json"))).resolves.toBeTruthy();
  });

  it("persists the Agents SDK session for each playtest across service instances", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "mosh-agent-sdk-session-"));
    const store = new PlaytestStore(dataDirectory);
    await store.initialize();
    const playtestId = crypto.randomUUID();
    const first = new FileAgentSession(store, playtestId);
    const item = { role: "user", content: "remember this turn" } as AgentInputItem;
    await first.addItems([item]);

    const restarted = new FileAgentSession(new PlaytestStore(dataDirectory), playtestId);
    expect(await restarted.getSessionId()).toBe(playtestId);
    expect(await restarted.getItems()).toEqual([item]);
  });

  it("purges non-retained transcripts while preserving pending reports and audit events", async () => {
    const supervisor = new FakeSupervisor(validPlan);
    const host = await fixture({ supervisor });
    const playtest = await createPlaytest(host.origin);
    expect((await post(host.origin, "/v1/supervisor/turns", validTurn(playtest.id))).status).toBe(200);
    const reportResponse = await post(host.origin, "/v1/reports", {
      playtestId: playtest.id,
      kind: "bug",
      title: "Loop was surprising",
      body: "The loop started one bar early.",
    });
    const report = await reportResponse.json() as { id: string };
    expect((await post(host.origin, `/v1/reports/${report.id}/approve`, {})).status).toBe(200);
    expect((await post(host.origin, `/v1/reports/${report.id}/repairs`, {})).status).toBe(503);
    expect((await post(host.origin, `/v1/playtests/${playtest.id}/close`, {})).status).toBe(200);

    await expect(readFile(path.join(host.dataDirectory, "sessions", playtest.id, "transcript.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(host.dataDirectory, "sessions", playtest.id, "reports", `${report.id}.json`), "utf8")).resolves.toContain("Loop was surprising");
    expect((await host.service.store.loadEvents(playtest.id)).map((event) => event.type)).toEqual([
      "playtest.created",
      "supervisor.turn.completed",
      "report.created",
      "report.approved",
      "report.sync.pending",
      "playtest.closed",
    ]);
  });

  it("retains transcripts when the close decision requests retention", async () => {
    const host = await fixture({ supervisor: new FakeSupervisor(validPlan) });
    const playtest = await createPlaytest(host.origin);
    await post(host.origin, "/v1/supervisor/turns", validTurn(playtest.id));
    await post(host.origin, `/v1/playtests/${playtest.id}/close`, { retainTranscript: true });
    const transcript = JSON.parse(await readFile(
      path.join(host.dataDirectory, "sessions", playtest.id, "transcript.json"),
      "utf8",
    )) as unknown[];
    expect(transcript).toHaveLength(2);
  });
});

describe("supervisor and OpenAI boundaries", () => {
  it("constructs the real hosted-trace runner with sensitive payload capture disabled", () => {
    const runner = createHostedTraceRunner();
    expect(runner.config.tracingDisabled).toBe(false);
    expect(runner.config.traceIncludeSensitiveData).toBe(false);
    expect(runner.config.workflowName).toBe("mosh-owner-playtest-supervisor");
  });

  it("uses a non-strict output envelope so capability-specific arguments remain dynamic", () => {
    expect(SupervisorOutputJsonSchema.strict).toBe(false);
    expect(SupervisorOutputJsonSchema.schema.additionalProperties).toBe(false);
    expect(
      SupervisorOutputJsonSchema.schema.properties.commands.items.properties.arguments,
    ).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });

  it("keeps local report APIs usable while returning a typed OpenAI unavailable response", async () => {
    const host = await fixture();
    const playtest = await createPlaytest(host.origin);
    const unavailable = await post(host.origin, "/v1/supervisor/turns", validTurn(playtest.id));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: {
        code: "openai_unavailable",
        message: "OpenAI supervisor is unavailable: OPENAI_API_KEY is not configured",
        retryable: true,
      },
    });
    expect((await post(host.origin, "/v1/reports", {
      playtestId: playtest.id,
      kind: "note",
      title: "Local note",
      body: "Still available without OpenAI.",
    })).status).toBe(201);
    const realtimeUnavailable = await post(host.origin, "/v1/realtime/client-secret", {});
    expect(realtimeUnavailable.status).toBe(503);
    expect((await realtimeUnavailable.json() as { error: { code: string } }).error.code).toBe("openai_unavailable");
  });

  it("validates fake-model structured output and rejects capabilities not supplied", async () => {
    const invalid = new FakeSupervisor({
      ...validPlan,
      commands: [{ capabilityId: "delete_project", arguments: {} }],
      selectedCapabilityIds: ["delete_project"],
    });
    const host = await fixture({ supervisor: invalid });
    const playtest = await createPlaytest(host.origin);
    const response = await post(host.origin, "/v1/supervisor/turns", validTurn(playtest.id));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });

  it("builds a typed allowlisted trace DTO that drops bypass-named artifacts", async () => {
    const supervisor = new FakeSupervisor(validPlan);
    const host = await fixture({ supervisor });
    const playtest = await createPlaytest(host.origin);
    const turn = validTurn(playtest.id);
    turn.capabilitySchemas[0]!.inputSchema = {
      type: "object",
      properties: { start: { type: "number" } },
      preview: "data:image/png;base64,c2NyZWVuc2hvdA==",
    } as never;
    turn.stateDigest = {
      playing: false,
      apiKey: "sk-primary-should-never-trace",
      screenshotData: "binary-image",
      preview: "data:image/png;base64,c2NyZWVuc2hvdA==",
      payload: "RIFF raw audio bytes",
      document: "private project content",
    } as never;
    turn.recentResults = [{
      ok: true,
      commandId: "set_loop",
      status: "ok",
      authorization: "Bearer launch-secret",
      message: "token sk-example123456789",
      preview: "data:image/png;base64,c2NyZWVuc2hvdA==",
      payload: "RIFF raw audio bytes",
      document: "private project content",
    }] as never;
    expect((await post(host.origin, "/v1/supervisor/turns", turn)).status).toBe(200);
    const traced = supervisor.inputs[0]!;
    expect(traced).not.toContain("primary-should-never-trace");
    expect(traced).not.toContain("binary-image");
    expect(traced).not.toContain("launch-secret");
    expect(traced).not.toContain("sk-example123456789");
    expect(traced).not.toContain("c2NyZWVuc2hvdA");
    expect(traced).not.toContain("raw audio bytes");
    expect(traced).not.toContain("private project content");
    expect(traced).toContain("[REDACTED]");
    expect(JSON.parse(traced)).toMatchObject({
      version: 1,
      state: { playing: false },
      recentResults: [{ ok: true, commandId: "set_loop", status: "ok" }],
      allowedCapabilityIds: ["set_loop"],
    });
    expect(supervisor.traces).toEqual([{ playtest_id: playtest.id }]);
    expect(supervisor.sessions).toEqual([playtest.id]);
  });

  it("redacts credential families and configured secrets before hosted supervisor input", async () => {
    const configuredSecret = "configured-owner-secret-value";
    process.env.MOSH_TEST_OWNER_SECRET = configuredSecret;
    try {
      const supervisor = new FakeSupervisor(validPlan);
      const host = await fixture({ supervisor });
      const playtest = await createPlaytest(host.origin);
      const turn = {
        ...validTurn(playtest.id),
        message: [
          "github_pat_abcdefghijklmnopqrstuvwxyz",
          "ghp_abcdefghijklmnopqrstuvwxyz",
          "SUPABASE_SERVICE_ROLE_KEY=role-secret",
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtb3NoIn0.c2lnbmF0dXJl",
          configuredSecret,
        ].join(" "),
        conversationContext: [{ role: "user" as const, text: `do not trace ${configuredSecret}` }],
      };

      expect((await post(host.origin, "/v1/supervisor/turns", turn)).status).toBe(200);
      const hostedInput = supervisor.inputs.join("\n");
      expect(hostedInput).not.toContain("github_pat_");
      expect(hostedInput).not.toContain("ghp_");
      expect(hostedInput).not.toContain("role-secret");
      expect(hostedInput).not.toContain("eyJhbGci");
      expect(hostedInput).not.toContain(configuredSecret);
      expect(hostedInput.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(6);
    } finally {
      delete process.env.MOSH_TEST_OWNER_SECRET;
    }
  });

  it("serializes parallel turns so transcript and SDK-session updates are not lost", async () => {
    const supervisor = new ConcurrentSessionSupervisor();
    const host = await fixture({ supervisor });
    const playtest = await createPlaytest(host.origin);
    const first = validTurn(playtest.id);
    first.message = "first turn";
    const second = validTurn(playtest.id);
    second.message = "second turn";

    const responses = await Promise.all([
      post(host.origin, "/v1/supervisor/turns", first),
      post(host.origin, "/v1/supervisor/turns", second),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(supervisor.maximumActive).toBe(1);

    const transcript = await host.service.store.loadTranscript(playtest.id) as Array<{ text: string }>;
    expect(transcript).toHaveLength(4);
    expect(transcript.map((entry) => entry.text).sort()).toEqual([
      "first turn",
      "reply:first turn",
      "second turn",
      "reply:second turn",
    ].sort());
    const sdkItems = await new FileAgentSession(host.service.store, playtest.id).getItems();
    expect(sdkItems).toHaveLength(4);
  });

  it("returns only ephemeral client-secret fields from an injected adapter", async () => {
    const realtime: RealtimeSecretAdapter = {
      mint: async () => ({
        value: "ek_ephemeral123456",
        expires_at: 2_000_000_000,
        api_key: "sk-primary123456789",
        nested: { secret: "must-not-return" },
      }),
    };
    const host = await fixture({ realtime });
    const response = await post(host.origin, "/v1/realtime/client-secret", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      value: "ek_ephemeral123456",
      expires_at: 2_000_000_000,
    });
  });
});

describe("event streaming", () => {
  it("serializes parallel event appends with unique contiguous sequence numbers", async () => {
    const host = await fixture();
    const playtest = await createPlaytest(host.origin);
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      host.service.emit(playtest.id, "test.parallel", { index })
    ));
    const events = await host.service.store.loadEvents(playtest.id);
    expect(events).toHaveLength(41);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 41 }, (_, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.sequence)).size).toBe(41);
  });

  it("replays persisted SSE events after the supplied Last-Event-ID", async () => {
    const host = await fixture();
    const playtest = await createPlaytest(host.origin);
    await host.service.emit(playtest.id, "test.first", { order: 1 });
    await host.service.emit(playtest.id, "test.second", { order: 2 });
    const events = await host.service.store.loadEvents(playtest.id);
    const controller = new AbortController();
    const response = await fetch(`${host.origin}/v1/playtests/${playtest.id}/events`, {
      headers: { Authorization: `Bearer ${capability}`, "Last-Event-ID": events[0]!.id },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    controller.abort();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain(`id: ${events[1]!.id}`);
    expect(text).toContain("event: test.first");
    expect(text).toContain(`id: ${events[2]!.id}`);
    expect(text).toContain("event: test.second");
    expect(text).not.toContain(`id: ${events[0]!.id}`);
  });
});
