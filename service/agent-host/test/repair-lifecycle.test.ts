import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitCliAdapter,
  localGitCommandEnvironment,
  NodeCommandRunner,
} from "../src/adapters.js";
import {
  orchestrationFixture,
  repairResult,
  restartedService,
} from "./orchestration-fixture.js";

describe("repair worktree and app lifecycle", () => {
  async function runGit(
    runner: NodeCommandRunner,
    repository: string,
    args: readonly string[],
  ) {
    const result = await runner.run("git", ["-C", repository, ...args]);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  it("refuses a dirty base and admits only one active approved repair", async () => {
    const { fakes, service, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    fakes.clean = false;
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "dirty_base" });
    fakes.clean = true;
    const first = await service.createRepair(report.id);
    expect(first.status).toBe("running");
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "repair_active" });
  });

  it("uses an isolated workspace-write thread and preserves draft-only output", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    const worktree = fakes.gitCalls
      .map((value) => JSON.parse(value) as { path: string; branch: string })[0];
    expect(worktree?.branch).toBe("codex/playtest-42-loop-jumps");
    expect(worktree?.path).toBe("/worktrees/playtest-42-loop-jumps");
    expect(fakes.appCalls.find((call) =>
      call.kind === "thread"
      && (call.value as { mode?: string }).mode === "workspace-write")?.value).toMatchObject({
      mode: "workspace-write",
      cwd: "/worktrees/playtest-42-loop-jumps",
    });

    const completed = await service.completeRepair(repair.id, repairResult);
    expect(completed.status).toBe("full_gate_pending");
    expect((await store.loadRepair(repair.id)).result?.merged).toBe(false);
  });

  it("preserves the queued crash-window reservation when worktree creation itself fails", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    fakes.failWorktree = true;
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "injected" });
    const reserved = (await store.listRepairs())[0];
    if (!reserved) throw new Error("Expected a reserved repair");
    expect(reserved).toMatchObject({
      status: "queued",
      failure: { code: "injected", message: "injected worktree failure" },
    });
    fakes.failWorktree = false;
    await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "repair_active" });
    expect(fakes.gitCalls).toHaveLength(1);
  });

  it.each(["initialize", "thread", "turn"] as const)(
    "marks %s startup failure terminal, emits a safe failure, removes its worktree, and permits retry",
    async (stage) => {
      const { fakes, service, store, report } = await orchestrationFixture();
      await service.approveReport(report.id);
      fakes.failAppAction = stage;

      await expect(service.createRepair(report.id)).rejects.toMatchObject({ code: "injected" });

      const failed = (await store.listRepairs())[0];
      expect(failed).toMatchObject({
        status: "failed",
        failure: { code: "injected", message: `injected ${stage} failure` },
      });
      expect(fakes.gitCalls.at(-1)).toContain('"remove":');
      expect((await store.loadEvents(report.playtestId)).at(-1)).toMatchObject({
        type: "repair.start.failed",
        data: { repairId: failed?.id, code: "injected", worktreeRemoved: true },
      });

      fakes.failAppAction = undefined;
      await expect(service.createRepair(report.id)).resolves.toMatchObject({ status: "running" });
    },
  );

  it.each(["thread", "turn"] as const)(
    "removes the real owned branch after %s startup failure so the deterministic retry succeeds",
    async (stage) => {
      const root = await mkdtemp(path.join(tmpdir(), "mosh-repair-git-retry-"));
      const repository = path.join(root, "repo");
      const worktreeRoot = path.join(root, "worktrees");
      await mkdir(repository);
      await mkdir(worktreeRoot);
      const runner = new NodeCommandRunner(localGitCommandEnvironment(process.env));
      await runGit(runner, repository, ["init"]);
      await writeFile(path.join(repository, "README.md"), "repair retry\n");
      await runGit(runner, repository, ["add", "README.md"]);
      await runGit(runner, repository, [
        "-c", "user.name=Mosh Test",
        "-c", "user.email=mosh-test@example.invalid",
        "commit", "-m", "fixture",
      ]);
      const baseSha = await runGit(runner, repository, ["rev-parse", "HEAD"]);
      const git = new GitCliAdapter(runner);
      const context = await orchestrationFixture({
        git,
        repositoryPath: repository,
        worktreeRoot,
        buildSha: baseSha,
      });
      await context.service.approveReport(context.report.id);
      context.fakes.failAppAction = stage;

      await expect(context.service.createRepair(context.report.id))
        .rejects.toMatchObject({ code: "injected" });
      const branch = "codex/playtest-42-loop-jumps";
      const missingBranch = await runner.run("git", [
        "-C", repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`,
      ]);
      expect(missingBranch.exitCode).toBe(1);

      context.fakes.failAppAction = undefined;
      const retry = await context.service.createRepair(context.report.id);
      expect(retry).toMatchObject({ status: "running", branch });
      expect(await runGit(runner, repository, [
        "rev-parse", "--verify", `refs/heads/${branch}`,
      ])).toBe(baseSha);

      await git.removeWorktree({
        repositoryPath: repository,
        path: retry.worktreePath ?? "",
        branch,
      });
    },
  );

  it("redacts hostile turn-start failures from returned errors, repair JSON, and events", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const hostile = [
      "Authorization: Bearer hostile-bearer-token",
      "OPENAI_API_KEY=sk-hostile-openai-token",
      "SUPABASE_SERVICE_ROLE_KEY=supabase-hostile-token",
      "/Users/owner/private/session.mosh",
    ].join(" ");
    fakes.failAppAction = "turn";
    fakes.failAppError = Object.assign(new Error(hostile), {
      code: "github_pat_hostilecodevalue",
    });

    let returned = "";
    try {
      await service.createRepair(report.id);
    } catch (error) {
      returned = JSON.stringify({
        code: (error as Error & { code?: string }).code,
        message: (error as Error).message,
      });
    }
    const durable = JSON.stringify({
      repairs: await store.listRepairs(),
      events: await store.loadEvents(report.playtestId),
      returned,
    });

    expect(durable).toContain("[REDACTED]");
    expect(durable).not.toMatch(
      /Authorization|hostile-bearer|sk-hostile|supabase-hostile|github_pat_hostile|\/Users\/owner/u,
    );
  });

  it("recovers active-job exclusion and rolls back in safe process order", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    const restarted = restartedService(store, fakes);
    await restarted.initialize();
    await expect(restarted.createRepair(report.id)).rejects.toMatchObject({ code: "repair_active" });

    await restarted.completeRepair(repair.id, repairResult);
    await restarted.launchRepairBuild(repair.id, "/build/Mosh.app");
    await restarted.rollbackRepair(repair.id, "retest failed");
    expect(fakes.processCalls).toEqual([
      "checkpoint", "stop_transport", "release_audio", "handoff_repair",
      "handoff_prior",
    ]);
    const types = (await store.loadEvents(report.playtestId)).map((event) => event.type);
    expect(types.slice(-6)).toEqual([
      "repair.checkpoint.created",
      "repair.transport.stopped",
      "repair.audio.released",
      "repair.build.handoff_accepted",
      "repair.rollback.handoff_accepted",
      "repair.swap.rolled_back",
    ]);
  });

  it("serializes parallel swaps and preserves a recoverable failed transition", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    await service.completeRepair(repair.id, repairResult);
    const attempts = await Promise.allSettled([
      service.launchRepairBuild(repair.id, "/build/Mosh.app"),
      service.launchRepairBuild(repair.id, "/build/Mosh.app"),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(fakes.processCalls.filter((call) => call === "handoff_repair")).toHaveLength(1);

    await service.rollbackRepair(repair.id, "parallel launch probe");
    expect((await store.loadRepair(repair.id)).swap?.state).toBe("rolled_back");

    const second = await orchestrationFixture();
    await second.service.approveReport(second.report.id);
    const secondRepair = await second.service.createRepair(second.report.id);
    await second.service.completeRepair(secondRepair.id, repairResult);
    second.fakes.failProcessAction = "handoff_repair";
    await expect(second.service.launchRepairBuild(secondRepair.id, "/build/Mosh.app"))
      .rejects.toMatchObject({ code: "injected" });
    expect(await second.store.loadRepair(secondRepair.id)).toMatchObject({
      checkpoint: { checkpointPath: "/tmp/checkpoint.mosh" },
      swap: { state: "failed", buildPath: "/build/Mosh.app" },
    });
    await second.service.rollbackRepair(secondRepair.id, "injected failure");
    expect((await second.store.loadRepair(secondRepair.id)).swap?.state).toBe("rolled_back");
  });

  it("rejects a launch path that differs from the validated result before checkpoint or close", async () => {
    const { fakes, service, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);
    await service.completeRepair(repair.id, repairResult);

    await expect(service.launchRepairBuild(repair.id, "/outside/Evil.app"))
      .rejects.toMatchObject({ code: "repair_build_mismatch" });

    expect(fakes.processCalls).toEqual([]);
  });

  it("rejects a claimed source SHA that differs from the repair worktree HEAD", async () => {
    const { fakes, service, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const repair = await service.createRepair(report.id);

    await expect(service.completeRepair(repair.id, {
      ...repairResult,
      sourceSha: "2".repeat(40),
    })).rejects.toMatchObject({ code: "repair_source_mismatch" });

    expect(fakes.processCalls).toEqual([]);
  });
});
