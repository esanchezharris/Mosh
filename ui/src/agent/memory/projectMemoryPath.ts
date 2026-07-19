// M3 — pure helper computing the client-visible path to a project's memory sidecar.
// Mirrors AgentMemoryStore::projectSidecarFile (src/moshops/AgentMemoryStore.h):
//   editFile.getParentDirectory().getChildFile(editFile.getFileName() + ".mosh-memory.json")
// which — since editFile IS parentDir + "/" + fileName — is exactly `${editFile}.mosh-
// memory.json` (no separator handling needed: we're appending a suffix to the FULL path,
// not rebuilding it from parts, so a Windows backslash editFile round-trips unchanged).
//
// Used by the memory panel's "Copy this project's memory path" affordance — there is no
// native "reveal in Finder" bridge command (JUCE's File::revealToUser() has no
// MoshOps/bridge surface today; see exportPath.ts/ExportControls.tsx's identical
// copy-path-then-Cmd-Shift-G posture, which this reuses).
export function projectMemoryPath(editFile: string): string {
  if (!editFile.trim()) return ""; // an unsaved session has no edit file, so no sidecar to point at
  return `${editFile}.mosh-memory.json`;
}
