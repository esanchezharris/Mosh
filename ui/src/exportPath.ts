// Pure helper for the post-export "where did my file go" UI (ExportControls). There is
// no native "reveal in Finder" bridge command (JUCE's File::revealToUser() has no
// MoshOps/bridge surface today — see ExportControls' comment), so the best available fix
// is surfacing the path clearly and making both the file and its folder copyable.
//
// Matches BOTH separators: export_audio's `file` comes from juce::File::getFullPathName(),
// which on the Windows target (a supported build, per CLAUDE.md's Windows-parity notes)
// returns backslash paths — a POSIX-only split silently returned "" there, so "Copy
// folder" no-op'd with no feedback on a Windows tester's PC.
export function parentDir(path: string): string {
  if (!path) return "";
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return "";
  return i === 0 ? "/" : path.slice(0, i);
}
