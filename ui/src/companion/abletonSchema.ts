import { z } from "zod";

export const RequestIdSchema = z.string().min(1).max(128).brand("AbletonRequestId");

const RevisionSchema = z.number().int().nonnegative();
const BeatSchema = z.number().nonnegative();

const TrackSchema = z
  .object({ id: z.string().min(1), name: z.string() })
  .strict()
  .readonly();

const ClipSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    startBeats: BeatSchema,
    endBeats: BeatSchema,
  })
  .strict()
  .refine((clip) => clip.endBeats >= clip.startBeats, { path: ["endBeats"] })
  .readonly();

export const AbletonSnapshotSchema = z
  .object({
    revision: RevisionSchema,
    connection: z.enum(["connected", "disconnected"]),
    transport: z.enum(["stopped", "recording", "playing"]),
    editMarkerBeats: BeatSchema,
    activeSource: TrackSchema.nullable(),
    passStartBeats: BeatSchema.nullable(),
    savedStopBeats: BeatSchema.nullable(),
    pendingClip: ClipSchema.nullable(),
    archiveClips: z.array(ClipSchema).readonly(),
    blockedReason: z.string().min(1).nullable(),
    ownershipUncertain: z.boolean(),
  })
  .strict()
  .readonly();

const SuccessEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    requestId: z.string(),
    revision: RevisionSchema,
    state: AbletonSnapshotSchema,
  })
  .strict()
  .refine((value) => value.revision === value.state.revision, { path: ["revision"] })
  .readonly();

const EmptyStateSchema = z.object({}).strict().readonly();
const ErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    requestId: z.string(),
    revision: RevisionSchema,
    state: z.union([AbletonSnapshotSchema, EmptyStateSchema]),
    error: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = AbletonSnapshotSchema.safeParse(value.state);
    if (parsed.success && parsed.data.revision !== value.revision) {
      context.addIssue({ code: "custom", path: ["revision"], message: "envelope/state revision mismatch" });
    }
  })
  .readonly();

export const AbletonEnvelopeSchema = z.union([SuccessEnvelopeSchema, ErrorEnvelopeSchema]);

function commonActionFields() {
  return { requestId: RequestIdSchema, expectedRevision: RevisionSchema };
}

const ButtonActionSchema = z
  .object({ ...commonActionFields(), action: z.enum(["put", "keep", "again", "hear", "stop"]) })
  .strict()
  .readonly();
const SeekActionSchema = z
  .object({ ...commonActionFields(), action: z.literal("seek"), positionBeats: BeatSchema })
  .strict()
  .readonly();

export const AbletonActionRequestSchema = z.discriminatedUnion("action", [ButtonActionSchema, SeekActionSchema]);

export type AbletonSnapshot = z.infer<typeof AbletonSnapshotSchema>;
export type AbletonEnvelope = z.infer<typeof AbletonEnvelopeSchema>;
export type AbletonActionRequest = z.infer<typeof AbletonActionRequestSchema>;
