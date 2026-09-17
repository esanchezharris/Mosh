import { useCallback, useEffect, useRef } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, [setOpen]);
  useEscapeToClose(open, close);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, setOpen]);

  const run = (id: "new_project" | "open_project" | "save" | "save_as" | "export_audio") => {
    setOpen(false);
    void runAction(id, actionCtx());
  };

  return (
    <div className={`menu sess-menu${open ? " open" : ""}`} ref={ref}>
      <button ref={triggerRef} className="sess-trig" type="button" title="File menu" aria-haspopup="menu"
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
        <button type="button" className="mi" role="menuitem" onClick={() => run("save_as")}>
          <span>Save As…</span><kbd>⇧⌘S</kbd>
        </button>
        <button type="button" className="mi" role="menuitem" onClick={() => {
          setOpen(false); useV3.getState().setPane("browser"); useV3.getState().setBrowserTab("files");
        }}><span>Import audio…</span></button>
        <button type="button" className="mi" role="menuitem" onClick={() => run("export_audio")}>
          <span>Export audio…</span>
        </button>
        <div className="sep" />
        <div className="mi mi-sub" role="menuitem" tabIndex={0} aria-haspopup="menu" aria-label="Templates"
          data-testid="v3-templates" onKeyDown={(event) => {
            if (event.target !== event.currentTarget || !["Enter", " ", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
          }}>
          <span>Templates</span><span className="chev">›</span>
          <div className="menu-sub" role="menu" aria-label="Templates">
            <button type="button" className="mi" role="menuitem" data-testid="v3-template-booth"
              onClick={() => { useStore.getState().setView("arrange"); setPosture("booth"); close(); }}>
              <span>Recording Booth</span>
              {posture === "booth" ? <span className="check">✓</span> : null}
            </button>
            <button type="button" className="mi" role="menuitem" data-testid="v3-template-studio"
              onClick={() => { useStore.getState().setView("arrange"); setPosture("studio"); close(); }}>
              <span>Full Studio</span>
              {posture === "studio" ? <span className="check">✓</span> : null}
            </button>
            <div className="mi muted"><span>Mix Focus</span><span className="soon">soon</span></div>
          </div>
        </div>
        <div className="sep" />
        <button type="button" className="mi" role="menuitem" data-testid="v3-open-settings"
          onClick={() => { close(); setSettingsOpen(true); }}>
          <span>Settings…</span><kbd>⌘,</kbd>
        </button>
      </div>
    </div>
  );
}
