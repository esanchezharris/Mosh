import { AgentHostService } from "./service.js";
import { OpenAIAgentsSupervisorAdapter, OpenAIRealtimeSecretAdapter } from "./openai.js";
import { defaultDataDirectory, PlaytestStore } from "./persistence.js";
import { startAgentHost } from "./server.js";

const apiKey = process.env.OPENAI_API_KEY;
const service = new AgentHostService(
  new PlaytestStore(process.env.MOSH_AGENT_HOST_DATA_DIR ?? defaultDataDirectory()),
  apiKey ? new OpenAIAgentsSupervisorAdapter() : undefined,
  apiKey ? new OpenAIRealtimeSecretAdapter(apiKey) : undefined,
);
const requestedPort = process.env.PORT === undefined ? 0 : Number.parseInt(process.env.PORT, 10);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error("PORT must be an integer from 0 through 65535");
}
const host = await startAgentHost({
  service,
  port: requestedPort,
  ...(process.env.MOSH_AGENT_HOST_CAPABILITY
    ? { capability: process.env.MOSH_AGENT_HOST_CAPABILITY }
    : {}),
});

process.stdout.write(`${JSON.stringify({
  type: "mosh.agent-host.ready",
  version: 1,
  host: host.host,
  port: host.port,
  capability: host.capability,
})}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await host.close();
    process.exit(0);
  });
}
