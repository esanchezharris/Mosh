import { stateSchema } from "../src/contract";
export const ready = stateSchema.parse({
  version: 1, sessionId: "session-1", projectId: "project-1", authority: "authority-1",
  phase: "ready", engaged: true, hostAlive: true, busy: false, recording: false, playing: false,
  listening: { bar: 5, qn: 16, entryQn: 12, leadQn: 4 },
  currentId: "part-3", lastId: "part-2", reviewId: null, auditionedId: "part-1",
  playbackScope: "none",
  contributions: [
    { id: "part-1", label: "Part 1", keeper: true, rejected: false },
    { id: "part-2", label: "Part 2", keeper: false, rejected: true },
    { id: "part-3", label: "Part 3", keeper: false, rejected: false },
  ], receipts: [], error: "",
});
