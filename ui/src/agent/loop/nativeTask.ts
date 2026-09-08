import { z } from "zod";
import { useStore } from "../../store";
import type { Snapshot } from "../../types";
import type { AgentExecution, StepCommandResult } from "../loopSeam";
import type { TaskExecutor, TaskExecDeps } from "./taskExec";

const snapshotSchema = z.custom<Snapshot>((value) => {
  if (!value || typeof value !== "object") return false;
  return "schemaVersion" in value && "session" in value && "tracks" in value
    && Array.isArray(value.tracks) && typeof value.session === "object";
});
const contextSchema = z.object({
  projectId: z.string().min(1), epoch: z.string().min(1), revision: z.number().int(), snapshot: snapshotSchema,
});
const executionSchema = z.object({
  requestId: z.string(), projectId: z.string(),
  status: z.enum(["prepared", "committed", "cancelled", "rolled_back", "unresolved", "undone", "rejected"]),
  appliedCount: z.number().int().nonnegative(), replayed: z.boolean().optional(), inProgress: z.boolean().optional(),
  error: z.string().optional(), undoable: z.boolean().optional(),
  results: z.array(z.object({ command: z.string(), ok: z.boolean(), error: z.string().optional() })).optional(),
});
export type NativeContext = z.infer<typeof contextSchema>;
export type NativeExecution = z.infer<typeof executionSchema>;
export type NativeTaskBinding = {
  requestId: string; payload: Record<string, unknown>; context: NativeContext;
  validate: (calls: Parameters<TaskExecutor["env"]["runBatch"]>[1]) => string | null;
};
const execNative = (command: string, args?: Record<string, unknown>) =>
  useStore.getState().exec(command, args, undefined, "producer_v0");

export async function readAgentContext(): Promise<NativeContext> {
  const result = await execNative("get_agent_context");
  if (!result.ok) throw new Error(result.error ?? "Native task context unavailable");
  return contextSchema.parse(result.data);
}

export async function nativeRequest(command: string, args: Record<string, unknown>): Promise<NativeExecution> {
  const result = await execNative(command, args);
  const parsed = executionSchema.safeParse(result.data);
  if (!parsed.success) throw new Error(result.error ?? "Native request disposition unavailable");
  return { ...parsed.data, ...(result.error ? { error: result.error } : {}) };
}

export function createNativeTaskExecutor(binding: NativeTaskBinding, deps: TaskExecDeps): TaskExecutor {
  const identity = { requestId: binding.requestId, projectId: binding.context.projectId };
  const send = deps.exec ?? execNative;
  let snapshot = binding.context.snapshot;
  let closed = false;
  let attempted = false;
  const request = async (command: string, args: Record<string, unknown>): Promise<NativeExecution> => {
    const result = await send(command, args, "producer_v0");
    const parsed = executionSchema.safeParse(result.data);
    if (!parsed.success) throw new Error(result.error ?? "Native request disposition unavailable");
    return { ...parsed.data, ...(result.error ? { error: result.error } : {}) };
  };
  const refresh = async () => {
    await (deps.refresh ?? (() => useStore.getState().refresh()))();
    snapshot = useStore.getState().snapshot ?? snapshot;
  };
  return {
    env: {
      getSnapshot: async () => snapshot,
      async runBatch(_label, calls) {
        if (closed || attempted) throw new Error("A bounded request can apply only once");
        const problem = binding.validate(calls);
        let execution: NativeExecution;
        if (problem || deps.signal?.aborted) {
          execution = await request("cancel_agent_request", identity);
          if (problem) execution = { ...execution, status: "rejected", error: problem };
        } else {
          attempted = true;
          try {
            execution = await request("apply_agent_patch", {
              ...identity, payload: binding.payload, epoch: binding.context.epoch,
              revision: binding.context.revision, commands: calls,
            });
          } catch {
            try { execution = await request("get_agent_request", identity); }
            catch { execution = { ...identity, status: "unresolved", appliedCount: 0, error: "Response and durable status unavailable; effects are unknown" }; }
          }
        }
        const results: StepCommandResult[] = calls.map((call, index) => {
          const actual = execution.results?.[index];
          return {
            command: call.command, ok: actual?.ok ?? false,
            error: actual?.error ?? (!actual ? execution.error ?? "Not attempted" : undefined),
            disposition: actual?.ok ? execution.status === "rolled_back" ? "rolled_back" : "applied"
              : actual ? "refused" : execution.status === "unresolved" || execution.status === "committed" ? "unconfirmed" : "not_attempted",
          };
        });
        // The native response is sent only after closing the identified transaction.
        try { await refresh(); }
        catch { execution = { ...execution, error: "Native outcome recorded; fresh observation unavailable" }; }
        return { results, snapshot, execution };
      },
    },
    opened: () => attempted,
    execRaw: async () => ({ ok: false, error: "Raw commands are unavailable in a bounded request" }),
    async close() {
      if (closed) return;
      closed = true;
      if (!attempted) await request("cancel_agent_request", identity);
    },
  };
}

export async function undoNativeTask(execution: AgentExecution): Promise<{ ok: boolean; message: string; execution?: AgentExecution }> {
  try {
    const result = await nativeRequest("undo_agent_request", {
      requestId: execution.requestId, projectId: execution.projectId,
    });
    await useStore.getState().refresh();
    return { ok: result.status === "undone", message: result.status === "undone" ? "Task undone." : result.error ?? "Task undo was refused.", execution: result };
  } catch (error) {
    return { ok: false, message: `Task undo refused: ${error instanceof Error ? error.message : "native outcome unavailable"}` };
  }
}
