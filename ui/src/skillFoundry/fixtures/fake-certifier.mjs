#!/usr/bin/env node
// Task 6 test fixture — stands in for a real Mosh binary's
// `--skill-foundry-certify-driver-v1` mode. Reads `--request <path> --result <path>` per the
// default runner adapter's contract and, controlled by `FAKE_CERTIFIER_MODE`, writes a
// `CertificationDriverResultV1`-shaped `result.json`, hangs (to exercise the process
// supervisor's timeout/kill path), or exits non-zero without writing anything.
//
// Never used by production code — imported only from `processSupervisor.test.ts` and
// `candidateEvals.test.ts` (or similar Task 6 tests) via `node fake-certifier.mjs ...`.

import { readFileSync, writeFileSync } from "node:fs";

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const mode = process.env.FAKE_CERTIFIER_MODE ?? "completed";
const requestPath = arg("--request");
const resultPath = arg("--result");

function readRequest() {
  return JSON.parse(readFileSync(requestPath, "utf8"));
}

switch (mode) {
  case "hang": {
    // Never exits on its own; the supervisor must terminate the process group on timeout.
    setInterval(() => {}, 1000);
    break;
  }
  case "crash": {
    process.exitCode = 1;
    break;
  }
  case "manual": {
    const request = readRequest();
    writeFileSync(
      resultPath,
      JSON.stringify({
        kind: "needs_manual_evidence",
        runId: request.runId,
        caseId: "physical-001",
        expectedObservation: "audible kept take after relaunch",
        artifact: request.artifact,
        evalSha256: request.evalSha256,
      }),
    );
    break;
  }
  case "blocked": {
    writeFileSync(resultPath, JSON.stringify({ kind: "blocked", code: "missing_primitive", message: "fake blocker" }));
    break;
  }
  case "completed":
  default: {
    const request = readRequest();
    const nowIso = new Date().toISOString();
    writeFileSync(
      resultPath,
      JSON.stringify({
        kind: "completed",
        report: {
          schemaVersion: 1,
          state: "acceptance_green",
          runId: request.runId,
          skillId: request.draftId,
          version: "1.0.0",
          artifact: request.artifact,
          evalSha256: request.evalSha256,
          gitCommit: "a".repeat(40),
          moshBuildIdentity: "git=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|version=1.0.0|target=Mosh|configuration=Release|architecture=arm64",
          commandCatalogSha256: request.catalogFingerprint.commandCatalogSha256,
          predicateCatalogVersion: request.catalogFingerprint.predicateCatalogVersion,
          resolverCatalogVersion: request.catalogFingerprint.resolverCatalogVersion,
          sourceStatusIndexSha256: request.sourceStatusIndexSha256,
          gates: [
            { name: "schema", status: "passed", startedAt: nowIso, finishedAt: nowIso, passed: 1, total: 1, artifactHashes: [] },
            { name: "mock", status: "passed", startedAt: nowIso, finishedAt: nowIso, passed: 1, total: 1, artifactHashes: [] },
            { name: "native", status: "passed", startedAt: nowIso, finishedAt: nowIso, passed: 1, total: 1, artifactHashes: [] },
            { name: "packaged", status: "passed", startedAt: nowIso, finishedAt: nowIso, passed: 1, total: 1, artifactHashes: [] },
            { name: "acceptance", status: "passed", startedAt: nowIso, finishedAt: nowIso, passed: 1, total: 1, artifactHashes: [] },
          ],
          manualEvidenceSha256: [],
          frozenAt: nowIso,
        },
      }),
    );
    break;
  }
}
