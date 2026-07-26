// The Open-Recent list, once. Three surfaces had grown near-identical copies of it
// (FileOptions' "+" popover, the classic TopbarTools File menu, and the Settings panel),
// and the v2 overflow menu was about to make four. AL-018's remaining tail.
//
// Each caller keeps its own chrome and data-testid, so this is a de-duplication, not a
// redesign — the DOM every existing test queries is unchanged.

import type { Snapshot } from "../types";

/** The index passed to onPick is the index into the BACKEND's list, not into whatever
 *  subset a caller renders. `open_recent` resolves an index against the live native
 *  list, so re-numbering a filtered view would open the wrong project. */
export function RecentProjectList({
  snapshot,
  variant,
  onPick,
  limit = 8,
  emptyLabel,
}: {
  snapshot: Snapshot | null;
  variant: "menu" | "sub";
  onPick: (index: number) => void;
  limit?: number;
  emptyLabel?: string;
}) {
  const s = snapshot?.session;
  const recents = (s?.recentProjects ?? []).slice(0, limit);
  if (recents.length === 0 && !emptyLabel) return null;

  if (variant === "menu") {
    // v2 overflow menu: flat role=menuitem rows, matching its siblings.
    return (
      <>
        {recents.map((p, i) => (
          <button key={p.path} role="menuitem" data-action="open_recent" title={p.path}
            disabled={p.path === s?.editFile}
            onClick={() => onPick(i)}>
            {p.path === s?.editFile ? "● " : ""}{p.name}
          </button>
        ))}
      </>
    );
  }

  // classic sub-list chrome (.menu-sub / .menu-item.sub), used by the File menu and the
  // "+" popover.
  return (
    <>
      <div className="menu-sub-head">Open Recent</div>
      {recents.length === 0
        ? <div className="rack-empty">{emptyLabel}</div>
        : recents.map((p, i) => (
            <button key={p.path} className="menu-item sub" role="menuitem" title={p.path}
              disabled={p.path === s?.editFile}
              onClick={() => onPick(i)}>
              <span className="menu-label">{p.path === s?.editFile ? "● " : ""}{p.name}</span>
            </button>
          ))}
    </>
  );
}
