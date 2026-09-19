import { z } from "zod";

export const actionSchema = z.enum(["record", "keep", "again", "hear", "play_all", "stop", "navigate", "home", "lead_in"]);
export type Action = z.infer<typeof actionSchema>;
export const partIdSchema = z.string().min(1).brand<"PartId">();
export type PartId = z.infer<typeof partIdSchema>;
export const requestIdSchema = z.string().min(1).brand<"RequestId">();
export type RequestId = z.infer<typeof requestIdSchema>;
export const tokenSchema = z.string().regex(/^[a-fA-F0-9]{32,128}$/).brand<"Token">();
export type Token = z.infer<typeof tokenSchema>;
const finite = z.number().finite();
export const receiptSchema = z.object({
  requestId: requestIdSchema, action: actionSchema,
  status: z.enum(["accepted", "running", "completed", "rejected", "cancelled"]),
  detail: z.string(), submittedMs: finite, completedMs: finite.nullable(),
  actionId: z.string(), targetId: partIdSchema.nullable(),
}).readonly();
export type Receipt = z.infer<typeof receiptSchema>;
export const stateSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1).brand<"SessionId">(),
  projectId: z.string().brand<"ProjectId">(), authority: z.string().brand<"Authority">(),
  phase: z.string(), engaged: z.boolean(), hostAlive: z.boolean(), busy: z.boolean(),
  recording: z.boolean(), playing: z.boolean(),
  playbackScope: z.enum(["arrangement", "selected", "none"]),
  listening: z.object({ bar: finite, qn: finite, entryQn: finite.nullable(), leadQn: finite }).readonly(),
  currentId: partIdSchema.nullable(), lastId: partIdSchema.nullable(),
  reviewId: partIdSchema.nullable(), auditionedId: partIdSchema.nullable(),
  contributions: z.array(z.object({ id: partIdSchema, label: z.string(), keeper: z.boolean(), rejected: z.boolean() }).readonly()).readonly(),
  receipts: z.array(receiptSchema).readonly(), error: z.string(),
}).readonly();
export type State = z.infer<typeof stateSchema>;
export const actionResponseSchema = z.object({ version: z.literal(1), receipt: receiptSchema, state: stateSchema }).readonly();
export const barSchema = z.coerce.number().int().min(1).max(1_000_000);
export type Command = {
  readonly version: 1; readonly requestId: RequestId;
  readonly sessionId: State["sessionId"]; readonly projectId: State["projectId"];
  readonly authority: State["authority"]; readonly action: Action;
  readonly targetId?: PartId; readonly bar?: number; readonly leadQn?: number;
};
export const leadQnSchema = z.coerce.number().finite().min(0).max(256);
