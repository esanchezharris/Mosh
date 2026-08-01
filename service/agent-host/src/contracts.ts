import { z } from "zod";

const isoDate = z.iso.datetime({ offset: true });
const id = z.uuid();
const jsonValue: z.ZodType<unknown> = z.json();

export const PlaytestSessionSchema = z.object({
  version: z.literal(1),
  id,
  status: z.enum(["active", "closed"]),
  retainTranscript: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
  closedAt: isoDate.optional(),
  coordinatorThreadId: z.string().min(1).optional(),
  coordinator: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("starting"),
      reservationId: id,
    }),
    z.object({
      state: z.literal("ready"),
      reservationId: id,
      threadId: z.string().min(1),
    }),
    z.object({
      state: z.literal("failed"),
      reservationId: id,
      code: z.string().min(1),
    }),
  ]).optional(),
});
export type PlaytestSession = z.infer<typeof PlaytestSessionSchema>;

export const EvidenceRecordSchema = z.object({
  version: z.literal(1),
  id,
  playtestId: id,
  reportId: id,
  kind: z.enum(["screenshot", "log", "diagnostic"]),
  localPath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: z.record(z.string(), jsonValue).default({}),
  createdAt: isoDate,
  remote: z.object({
    evidenceId: id,
    objectPath: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    previewUrl: z.url(),
    previewExpiresAt: isoDate,
  }).optional(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const PlaytestReportSchema = z.object({
  version: z.literal(1),
  id,
  playtestId: id,
  kind: z.enum(["blocker", "bug", "note"]),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  status: z.enum(["draft", "approved", "approved_pending_sync"]),
  evidence: z.array(EvidenceRecordSchema).default([]),
  createdAt: isoDate,
  updatedAt: isoDate,
  approvedAt: isoDate.optional(),
  external: z.object({
    issueNumber: z.number().int().positive(),
    issueUrl: z.url(),
  }).optional(),
  syncIntent: z.object({
    marker: z.string().min(1),
    state: z.enum(["pending", "synced"]),
    updatedAt: isoDate,
    issueNumber: z.number().int().positive().optional(),
  }).optional(),
});
export type PlaytestReport = z.infer<typeof PlaytestReportSchema>;

export const RepairJobSchema = z.object({
  version: z.literal(1),
  id,
  playtestId: id,
  reportId: id,
  status: z.enum(["queued", "running", "full_gate_pending", "failed", "cancelled"]),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  branch: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  repairThreadId: z.string().min(1).optional(),
  checkpoint: z.object({
    checkpointPath: z.string().min(1),
    priorAppPath: z.string().min(1),
  }).optional(),
  failure: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).optional(),
  swap: z.object({
    state: z.enum([
      "checkpointed",
      "stopping",
      "repair_running",
      "rolling_back",
      "rolled_back",
      "failed",
    ]),
    buildPath: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  }).optional(),
  result: z.object({
    redEvidencePath: z.string().min(1),
    greenEvidencePath: z.string().min(1),
    diagnosticsPath: z.string().min(1),
    bundlePath: z.string().min(1),
    buildPath: z.string().min(1),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    draftPrUrl: z.url(),
    draft: z.literal(true),
    merged: z.literal(false),
  }).optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type RepairJob = z.infer<typeof RepairJobSchema>;

export const AuditEventSchema = z.object({
  version: z.literal(1),
  id,
  playtestId: id,
  sequence: z.number().int().positive(),
  type: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  at: isoDate,
  data: z.record(z.string(), jsonValue).default({}),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const CapabilitySchema = z.object({
  id: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  inputSchema: z.record(z.string(), jsonValue),
});
export type Capability = z.infer<typeof CapabilitySchema>;

export const SupervisorCommandSchema = z.object({
  capabilityId: z.string().trim().min(1),
  arguments: z.record(z.string(), jsonValue),
});

export const SupervisorPlanSchema = z.object({
  intent: z.string().trim().min(1).max(500),
  say: z.string().max(2_000),
  commands: z.array(SupervisorCommandSchema).max(20),
  needsClarification: z.boolean(),
  selectedCapabilityIds: z.array(z.string().trim().min(1)).max(20),
}).superRefine((plan, context) => {
  const selected = new Set(plan.selectedCapabilityIds);
  for (const command of plan.commands) {
    if (!selected.has(command.capabilityId)) {
      context.addIssue({
        code: "custom",
        message: `Command capability ${command.capabilityId} was not selected`,
        path: ["commands"],
      });
    }
  }
});
export type SupervisorPlan = z.infer<typeof SupervisorPlanSchema>;

export const SupervisorTurnSchema = z.object({
  playtestId: id,
  message: z.string().trim().min(1).max(20_000),
  capabilitySchemas: z.array(CapabilitySchema).max(200),
  stateDigest: z.record(z.string(), jsonValue),
  recentResults: z.array(z.record(z.string(), jsonValue)).max(50),
  conversationContext: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(20_000),
  })).max(100),
});
export type SupervisorTurn = z.infer<typeof SupervisorTurnSchema>;

export const OpenAIUnavailableSchema = z.object({
  error: z.object({
    code: z.literal("openai_unavailable"),
    message: z.string(),
    retryable: z.boolean(),
  }),
});

export const RealtimeClientSecretSchema = z.object({
  value: z.string().startsWith("ek_"),
  expires_at: z.number().int().positive(),
});

export function parseRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
