// PRJ-NAME — the UI's view of project-file identity: what a project is called, and what
// extension its file wears. Pure string helpers, no store and no bridge, so they unit-test
// directly. The C++ counterpart is src/state/ProjectName.h.
//
// The CURRENT extension is backend-owned — it arrives on the snapshot as
// session.projectExtension (MoshOps writes it from the live edit file), so the UI never
// holds a second source of truth. FALLBACK_PROJECT_EXT is only for a snapshot that
// predates the field, or a test fake that omits it.
//
// The LEGACY extension is hardcoded and OPEN-ONLY. Projects saved before the .mosh rename
// are never migrated, so an Open dialog that filtered them out would make a producer's
// existing work look like it had vanished. Save As must never propose it as a NEW
// destination.

export const FALLBACK_PROJECT_EXT = "mosh";
export const LEGACY_PROJECT_EXT = "tracktionedit";

/** The display name of a project file: its basename with the extension stripped.
 *  Returns "" for an empty path, so each caller picks its own fallback wording. */
export const projectLabel = (path: string): string =>
  ((path.split("/").pop() ?? path).replace(/\.[^.]+$/, ""));

/** Open filter: the current extension PLUS the legacy one (back-compat). */
export const openProjectFilters = (ext: string): string =>
  (ext === LEGACY_PROJECT_EXT ? [ext] : [ext, LEGACY_PROJECT_EXT]).map((e) => `*.${e}`).join(";");

/** Save filter: the current extension ONLY. */
export const saveProjectFilters = (ext: string): string => `*.${ext}`;

/** Pre-fill for Save As: the open project's own stem with the current extension, so the
 *  dialog offers "untitled - bearcat.mosh" instead of an empty field. */
export const saveProjectDefaultName = (editFile: string, ext: string): string =>
  `${projectLabel(editFile) || "untitled"}.${ext}`;
