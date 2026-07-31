import { z } from "zod";
import type { PlaytestReport } from "./contracts.js";

const safeText = z.string().max(20_000).refine(
  (value) => !value.includes("\0")
    && !/data:(?:audio|image)\//i.test(value)
    && !/[A-Za-z0-9+/]{512,}={0,2}/.test(value),
  "Binary or encoded payloads are not allowed in Codex context",
);

const transcriptEntry = z.object({
  role: z.enum(["user", "assistant"]),
  text: safeText,
  at: z.iso.datetime({ offset: true }).optional(),
}).strict();

const recentEnvelope = z.object({
  command: z.string().trim().min(1).max(100),
  ok: z.boolean(),
  code: z.string().trim().min(1).max(100).optional(),
  status: z.string().trim().min(1).max(100).optional(),
  undoable: z.boolean().optional(),
}).strict();

const context = z.object({
  session: z.object({
    playtestId: z.uuid(),
    text: z.array(transcriptEntry).max(100),
  }).strict(),
  report: z.object({
    id: z.uuid(),
    kind: z.enum(["blocker", "bug", "note"]),
    title: safeText,
    body: safeText,
  }).strict(),
  issue: z.object({
    issueNumber: z.number().int().positive(),
    issueUrl: z.url(),
  }).strict().optional(),
  evidence: z.array(z.object({
    localScreenshotPath: z.string().min(1).optional(),
    buildSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    dirtyDigest: z.union([
      z.literal("clean"),
      z.string().regex(/^[a-f0-9]{64}$/),
    ]).optional(),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    timelinePosition: z.number().finite().optional(),
    recentMoshOpsEnvelopes: z.array(recentEnvelope).max(50),
  }).strict()).max(50),
}).strict();

export function reportContext(report: PlaytestReport, sessionText: unknown[] = []): string {
  return JSON.stringify(context.parse({
    session: { playtestId: report.playtestId, text: sessionText },
    report: { id: report.id, kind: report.kind, title: report.title, body: report.body },
    issue: report.external,
    evidence: report.evidence.map((item) => ({
      localScreenshotPath: item.kind === "screenshot" ? item.localPath : undefined,
      buildSha: item.metadata.buildSha,
      dirtyDigest: item.metadata.dirtyDigest,
      snapshotDigest: item.metadata.snapshotDigest,
      timelinePosition: item.metadata.timelinePosition,
      recentMoshOpsEnvelopes: item.metadata.recentResults ?? [],
    })),
  }));
}
