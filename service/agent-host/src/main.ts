import { randomBytes } from "node:crypto";
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
import { readOwnerEnvironment } from "./owner-env.js";
import { NativeRepairArtifactPolicy } from "./repair-artifact-policy.js";

const ownerEnvironment = readOwnerEnvironment();
const apiKey = ownerEnvironment.OPENAI_API_KEY;
const capability = ownerEnvironment.MOSH_AGENT_HOST_CAPABILITY
  ?? randomBytes(32).toString("base64url");
const githubRunner = new NodeCommandRunner(githubCommandEnvironment(ownerEnvironment));
const gitRunner = new NodeCommandRunner(localGitCommandEnvironment(ownerEnvironment));
const repairRunner = new NodeCommandRunner(repairHelperCommandEnvironment(ownerEnvironment));
const codex = new LazyCodexAppServerAdapter();
const evidenceEndpoint = ownerEnvironment.MOSH_PLAYTEST_EVIDENCE_URL;
const evidenceSecret = ownerEnvironment.MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET;
const githubRepository = ownerEnvironment.MOSH_GITHUB_REPOSITORY;
const repositoryPath = ownerEnvironment.MOSH_REPOSITORY_PATH;
const worktreeRoot = ownerEnvironment.MOSH_REPAIR_WORKTREE_ROOT;
const repairHelper = ownerEnvironment.MOSH_REPAIR_CONTROL_HELPER;
const repairHelperTeamId = ownerEnvironment.MOSH_REPAIR_CONTROL_TEAM_ID;
const repairControlUrl = ownerEnvironment.MOSH_REPAIR_CONTROL_URL;
const dataDirectory = ownerEnvironment.MOSH_AGENT_HOST_DATA_DIR ?? defaultDataDirectory();
const store = new PlaytestStore(dataDirectory);
const repairArtifacts = new NativeRepairArtifactPolicy();
const orchestration = evidenceEndpoint && evidenceSecret && githubRepository
  && repositoryPath && worktreeRoot && repairHelper && repairHelperTeamId && repairControlUrl
  ? new OwnerOrchestrator(store, {
      evidence: new EdgeFunctionEvidenceAdapter({
        endpoint: evidenceEndpoint,
        ownerSecret: evidenceSecret,
      }),
      github: new GhGitHubAdapter(githubRunner, githubRepository),
      appServer: codex,
      git: new GitCliAdapter(gitRunner),
      processes: new RepairControlAdapter(repairRunner, repairHelper, {
        endpoint: repairControlUrl,
        capability,
        helperTeamId: repairHelperTeamId,
      }, repairArtifacts),
      artifacts: repairArtifacts,
      repositoryPath,
      worktreeRoot,
    })
  : undefined;
const service = new AgentHostService(
  store,
  apiKey ? new OpenAIAgentsSupervisorAdapter(apiKey) : undefined,
  apiKey ? new OpenAIRealtimeSecretAdapter(apiKey) : undefined,
  orchestration,
);
const requestedPort = ownerEnvironment.PORT === undefined ? 0 : Number.parseInt(ownerEnvironment.PORT, 10);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error("PORT must be an integer from 0 through 65535");
}
const host = await startAgentHost({
  service,
  port: requestedPort,
  capability,
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
