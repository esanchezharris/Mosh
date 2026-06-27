// App router — picks the active shell (classic vs the new v2 shell) from the
// `uiShell` UI-local setting, honoring a dev-only `?shell=` override. This is the
// single mount point main.tsx renders; it owns the data lifecycle (init() runs once
// here, so switching shells at runtime never re-subscribes the event feed). Both
// shells are pure clients of the same store/seam — the backend is identical either way.

import { useEffect } from "react";
import { useStore } from "./store";
import { useSettings } from "./settings/store";
import { resolveShell } from "./v2/shellQuery";
import { AppLegacy } from "./AppLegacy";
import { AppV2 } from "./v2/AppV2";

export function App() {
  const init = useStore((s) => s.init);
  const uiShell = useSettings((s) => s.get("uiShell"));
  const shell = resolveShell(uiShell);

  useEffect(() => { init(); }, [init]);

  return shell === "v2" ? <AppV2 /> : <AppLegacy />;
}
