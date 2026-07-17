// Pure helper for the post-export "where did my file go" UI (ExportControls). There is
// no native "reveal in Finder" bridge command (JUCE's File::revealToUser() has no
// MoshOps/bridge surface today — see ExportControls' comment), so the best available fix
// is surfacing the path clearly and making both the file and its folder copyable.
export function parentDir(path: string): string {
  if (!path) return "";
  const i = path.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 ? "/" : path.slice(0, i);
}
