// App router — picks the active shell (classic vs the new v2 shell) from the
// `uiShell` UI-local setting, honoring a dev-only `?shell=` override. This is the
// single mount point main.tsx renders; it owns the data lifecycle (init() runs once
// here, so switching shells at runtime never re-subscribes the event feed). Both
// shells are pure clients of the same store/seam — the backend is identical either way.

import { lazy, Suspense, useEffect } from "react";
import { useStore } from "./store";
import { useSettings } from "./settings/store";
import { resolveShell } from "./v2/shellQuery";
import { isCharacterLab } from "./lab/labQuery";
import { AppLegacy } from "./AppLegacy";
import { AppV2 } from "./v2/AppV2";
import { AppLive } from "./live/AppLive";

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
  const uiShell = useSettings((s) => s.get("uiShell"));
  const shell = resolveShell(uiShell);

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
  return shell === "live" ? <AppLive /> : shell === "v2" ? <AppV2 /> : <AppLegacy />;
}
