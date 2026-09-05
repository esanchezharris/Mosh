import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { useV3 } from "./shellState";

export function ContextMenu() {
  const ctx = useV3((s) => s.context);
  const setContext = useV3((s) => s.setContext);
  const exec = useStore((s) => s.exec);
  const confirm = Boolean(useSettings((s) => s.get("agentConfirmDestructive")));
  if (!ctx) return null;

  const close = () => setContext(null);
  const del = () => {
    if (confirm && !window.confirm("Delete this clip?")) return;
    void exec("remove_clip", { clipId: ctx.clipId });
    close();
  };

  return (
    <div className="ctx-menu open" role="menu" data-testid="v3-context"
      style={{ top: ctx.y, left: ctx.x }} onMouseLeave={close}>
      <button type="button" className="mi" onClick={() => {
        const name = window.prompt("Rename clip");
        if (name) void exec("rename_clip", { clipId: ctx.clipId, name });
        close();
      }}><span>Rename</span></button>
      <button type="button" className="mi" onClick={() => { void exec("duplicate_clip", { clipId: ctx.clipId }); close(); }}>
        <span>Duplicate</span><kbd>⌘D</kbd>
      </button>
      <button type="button" className="mi" onClick={() => { void exec("freeze_track", { trackId: ctx.trackId }); close(); }}>
        <span>Freeze</span>
      </button>
      <button type="button" className="mi" onClick={() => { void exec("bounce_track", { trackId: ctx.trackId }); close(); }}>
        <span>Bounce</span>
      </button>
      <div className="sep" />
      <button type="button" className="mi danger" data-testid="v3-context-delete" onClick={del}>
        <span>Delete</span><kbd>⌫</kbd>
      </button>
    </div>
  );
}
