// App root — the single mount point main.tsx renders. It owns the data lifecycle (init()
// runs once here) and mounts the V3 shell, the only interface since the old Classic, v2,
// Live and Pro Tools shells were retired (docs/SHELL-RETIREMENT-PLAN-2026-11-17.md; their
// last source is at tag archive/shells-2026-11-23). The shell is a pure client of the
// store/seam.

import { lazy, Suspense, useEffect } from "react";
import { useStore } from "./store";
import { isCharacterLab } from "./lab/labQuery";
import { AppV3 } from "./v3/AppV3";

// Dev-only Character Lab demo. The reference is gated on an explicit development mode so that in
// the production build the ternary folds to a literal `null` and the lazy import() lands in
// dead code Rollup removes — dropping the panel, its CSS and the vendored WebGL blob from
// the shipped single-file bundle entirely (this build inlines all chunks, so a plain lazy()
// alone would NOT exclude it). "Unreachable in production" thus holds at the bundle level.
const CharacterLab = import.meta.env.MODE === "development"
  ? lazy(() => import("./lab/CharacterLab").then((m) => ({ default: m.CharacterLab })))
  : null;

export function App() {
  const init = useStore((s) => s.init);

  // Dev-only Character Lab demo: `?view=character-lab` swaps the whole shell for the
  // knob demo and never touches the store, so it has zero backend dependency and can't
  // perturb a session. Unreachable in the shipped production-mode bundle.
  const charLab = isCharacterLab();

  useEffect(() => { if (!charLab) init(); }, [init, charLab]);

  if (charLab && CharacterLab) return (
    <Suspense fallback={null}>
      <CharacterLab />
    </Suspense>
  );
  return <AppV3 />;
}
