import { AgentHostService } from "./service.js";
import { OpenAIAgentsSupervisorAdapter, OpenAIRealtimeSecretAdapter } from "./openai.js";
import { defaultDataDirectory, PlaytestStore } from "./persistence.js";
import { startAgentHost } from "./server.js";
import {
  EdgeFunctionEvidenceAdapter,
  GhGitHubAdapter,
  GitCliAdapter,
  githubCommandEnvironment,
  localGitCommandEnvironment,
  LazyCodexAppServerAdapter,
  NodeCommandRunner,
  repairHelperCommandEnvironment,
  RepairControlAdapter,
} from "./adapters.js";
import { OwnerOrchestrator } from "./orchestration.js";
import { NativeRepairArtifactPolicy } from "./repair-artifact-policy.js";

const apiKey = process.env.OPENAI_API_KEY;
const githubRunner = new NodeCommandRunner(githubCommandEnvironment(process.env));
const gitRunner = new NodeCommandRunner(localGitCommandEnvironment(process.env));
const repairRunner = new NodeCommandRunner(repairHelperCommandEnvironment(process.env));
const codex = new LazyCodexAppServerAdapter();
const evidenceEndpoint = process.env.MOSH_PLAYTEST_EVIDENCE_URL;
const evidenceSecret = process.env.MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET;
const githubRepository = process.env.MOSH_GITHUB_REPOSITORY;
const repositoryPath = process.env.MOSH_REPOSITORY_PATH;
const worktreeRoot = process.env.MOSH_REPAIR_WORKTREE_ROOT;
const repairHelper = process.env.MOSH_REPAIR_CONTROL_HELPER;
const dataDirectory = process.env.MOSH_AGENT_HOST_DATA_DIR ?? defaultDataDirectory();
const store = new PlaytestStore(dataDirectory);
const repairArtifacts = new NativeRepairArtifactPolicy();
const orchestration = evidenceEndpoint && evidenceSecret && githubRepository
  && repositoryPath && worktreeRoot && repairHelper
  ? new OwnerOrchestrator(store, {
      evidence: new EdgeFunctionEvidenceAdapter({
        endpoint: evidenceEndpoint,
        ownerSecret: evidenceSecret,
      }),
      github: new GhGitHubAdapter(githubRunner, githubRepository),
      appServer: codex,
      git: new GitCliAdapter(gitRunner),
      processes: new RepairControlAdapter(repairRunner, repairHelper, repairArtifacts),
      artifacts: repairArtifacts,
      repositoryPath,
      worktreeRoot,
    })
  : undefined;
const service = new AgentHostService(
  store,
  apiKey ? new OpenAIAgentsSupervisorAdapter() : undefined,
  apiKey ? new OpenAIRealtimeSecretAdapter(apiKey) : undefined,
  orchestration,
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
    codex.close();
    await host.close();
    process.exit(0);
  });
}
