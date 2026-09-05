import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile } from "../bridge";
import { runAction } from "../menuActions";
import { useV3 } from "./shellState";

function actionCtx() {
  return { store: useStore.getState(), pickFiles, pickSaveFile };
}

export function FileMenu({ title }: { title: string }) {
  const open = useV3((s) => s.fileOpen);
  const setOpen = useV3((s) => s.setFileOpen);
  const posture = useV3((s) => s.posture);
  const setPosture = useV3((s) => s.setPosture);
  const setSettingsOpen = useV3((s) => s.setSettingsOpen);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, setOpen]);

  const run = (id: "new_project" | "open_project" | "save") => {
    setOpen(false);
    void runAction(id, actionCtx());
  };

  return (
    <div className={`menu sess-menu${open ? " open" : ""}`} ref={ref}>
      <button className="sess-trig" type="button" title="File menu" aria-haspopup="true"
        aria-expanded={open} data-testid="v3-file-trigger" onClick={() => setOpen(!open)}>
        <b>{title}</b><span className="caret" aria-hidden="true" />
      </button>
      <div className="menu-drop" role="menu" data-testid="v3-file-menu" aria-hidden={!open}
        ref={(el) => { if (el) el.inert = !open; }}>
        <button type="button" className="mi" role="menuitem" onClick={() => run("new_project")}>
          <span>New Session</span><kbd>⌘N</kbd>
        </button>
        <button type="button" className="mi" role="menuitem" onClick={() => run("open_project")}>
          <span>Open…</span><kbd>⌘O</kbd>
        </button>
        <button type="button" className="mi" role="menuitem" onClick={() => run("save")}>
          <span>Save</span><kbd>⌘S</kbd>
        </button>
        <div className="sep" />
        <div className="mi mi-sub" role="menuitem" data-testid="v3-templates">
          <span>Templates</span><span className="chev">›</span>
          <div className="menu-sub" role="menu">
            <button type="button" className="mi" data-testid="v3-template-booth"
              onClick={() => { setPosture("booth"); setOpen(false); }}>
              <span>Recording Booth</span>
              {posture === "booth" ? <span className="check">✓</span> : null}
            </button>
            <button type="button" className="mi" data-testid="v3-template-studio"
              onClick={() => { setPosture("studio"); setOpen(false); }}>
              <span>Full Studio</span>
              {posture === "studio" ? <span className="check">✓</span> : null}
            </button>
            <div className="mi muted"><span>Mix Focus</span><span className="soon">soon</span></div>
          </div>
        </div>
        <div className="sep" />
        <button type="button" className="mi" role="menuitem" data-testid="v3-open-settings"
          onClick={() => { setOpen(false); setSettingsOpen(true); }}>
          <span>Settings…</span><kbd>⌘,</kbd>
        </button>
      </div>
    </div>
  );
}
