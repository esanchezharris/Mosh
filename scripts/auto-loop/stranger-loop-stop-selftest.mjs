#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL(
  "../../.claude/workflows/stranger-loop.workflow.js",
  import.meta.url,
);
const source = (await readFile(workflowUrl, "utf8")).replace(
  "export const meta =",
  "const meta =",
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runWorkflow = new AsyncFunction(
  "args",
  "agent",
  "phase",
  "parallel",
  "log",
  source,
);

async function run(args, reply) {
  const calls = [];
  const result = await runWorkflow(
    args,
    async (prompt, options = {}) => {
      calls.push({ label: options.label || "", prompt });
      return reply(options.label || "", prompt);
    },
    () => {},
    async (tasks) => Promise.all(tasks.map((task) => task())),
    () => {},
  );
  return { calls, result };
}

{
  const { calls, result } = await run(
    { dryRun: false, planOnly: false, baselineN: null },
    (label) => {
      if (label === "stop-check") return { stop: true };
      throw new Error(`entry STOP allowed ${label || "an unlabeled action"}`);
    },
  );
  assert.equal(result.halted, "stop-sentinel");
  assert.deepEqual(calls.map(({ label }) => label), ["stop-check"]);
}

{
  let stopChecks = 0;
  const item = {
    id: "FS-TEST",
    title: "test",
    lane: "T",
    class: "cheap",
    order: 1,
  };
  const { calls, result } = await run(
    {
      dryRun: false,
      planOnly: false,
      baselineN: 1,
      maxCycles: 1,
      maxItems: 1,
    },
    (label) => {
      if (label === "stop-check") return { stop: ++stopChecks > 1 };
      if (label === "load:c1") return { stop: false, items: [item] };
      if (label === "plan:FS-TEST") {
        return { id: item.id, planned: true, gapExists: false };
      }
      if (label.startsWith("status:")) return { ok: true, stopped: false };
      throw new Error(`mid-plan STOP allowed ${label || "an unlabeled action"}`);
    },
  );
  assert.ok(result.halts.includes("stop-sentinel"));
  assert.equal(
    calls.some(({ label }) => label.startsWith("status:")),
    false,
    "STOP after Plan must prevent backlog status mutation",
  );
}

{
  let prepareStopped = false;
  const item = {
    id: "FS-TEST",
    title: "test",
    lane: "T",
    class: "cheap",
    order: 1,
  };
  const { calls, result } = await run(
    {
      dryRun: false,
      planOnly: false,
      baselineN: 1,
      maxCycles: 1,
      maxItems: 1,
    },
    (label) => {
      if (label === "stop-check") return { stop: prepareStopped };
      if (label === "load:c1") return { stop: false, items: [item] };
      if (label === "plan:FS-TEST") {
        return { id: item.id, planned: true, gapExists: true };
      }
      if (label === "status:in_progress") return { ok: true, stopped: false };
      if (label === "impl:FS-TEST") {
        return { ...item, slug: "fs-test", ready: true, prNumber: 1 };
      }
      if (label === "prepare:FS-TEST") {
        prepareStopped = true;
        return {
          ready: false,
          stopped: true,
          reason: "STOP sentinel present — gate result discarded",
        };
      }
      if (label.startsWith("reject:")) return { rejected: false, stopped: true };
      if (label.startsWith("status:")) return { ok: true, stopped: false };
      throw new Error(`mid-prepare STOP allowed ${label || "an unlabeled action"}`);
    },
  );
  assert.ok(result.halts.includes("stop-sentinel"));
  assert.equal(
    calls.some(({ label }) => label.startsWith("reject:")),
    false,
    "a stopped prepare must not be reclassified as a rejection",
  );
  assert.equal(
    calls.some(({ label }) => label === "status:needs-human"),
    false,
    "a stopped prepare must not mutate backlog status",
  );
}

console.log("stranger-loop-stop-selftest: PASS");
