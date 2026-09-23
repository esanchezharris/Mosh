import { pickFiles, pickSaveFile } from "../bridge";
import { runAction, type RunActionOptions } from "../menuActions";
import { useStore } from "../store";
import { useV3 } from "./shellState";

// The clip context menu. No item may use window.confirm / window.prompt: JUCE's macOS WKWebView
// delegate implements neither (confirm answers false, prompt null), so a dialog-gated item does
// nothing in the packaged app. Delete is one undo step, so ⌘Z is its safety net; there is no
// Rename here until V3 has an inline field for it.
export function ContextMenu() {
  const ctx = useV3((s) => s.context);
  const setContext = useV3((s) => s.setContext);
  const exec = useStore((s) => s.exec);
  const frozen = useStore((s) => s.snapshot?.tracks.find((t) => t.id === ctx?.trackId)?.frozen === true);
  if (!ctx) return null;

  const close = () => setContext(null);
  // Freeze and Bounce go through the shared menu actions (the Edit-menu path): they refresh after
  // the engine answers, surface a refusal through lastError, freeze_track toggles to unfreeze on a
  // frozen track, and bounce_track always carries a mode (engine and mock refuse one without).
  const action = (id: "freeze_track" | "bounce_track", opts: RunActionOptions) => {
    void runAction(id, { store: useStore.getState(), pickFiles, pickSaveFile }, opts);
    close();
  };

  return (
    <div className="ctx-menu open" role="menu" data-testid="v3-context"
      style={{ top: ctx.y, left: ctx.x }} onMouseLeave={close}>
      {ctx.time !== undefined && (
        <button type="button" className="mi" data-testid="v3-context-split"
          onClick={() => { void exec("split_clip", { clipId: ctx.clipId, time: ctx.time }); close(); }}>
          <span>Split here</span>
        </button>
      )}
      <button type="button" className="mi" onClick={() => { void exec("duplicate_clip", { clipId: ctx.clipId }); close(); }}>
        <span>Duplicate</span><kbd>⌘D</kbd>
      </button>
      <button type="button" className="mi" data-testid="v3-context-freeze"
        onClick={() => action("freeze_track", { trackId: ctx.trackId })}>
        <span>{frozen ? "Unfreeze" : "Freeze"}</span>
      </button>
      <button type="button" className="mi" data-testid="v3-context-bounce"
        onClick={() => action("bounce_track", { trackId: ctx.trackId, mode: "newTrack" })}>
        <span>Bounce to new track</span>
      </button>
      <div className="sep" />
      <button type="button" className="mi danger" data-testid="v3-context-delete"
        onClick={() => { void exec("remove_clip", { clipId: ctx.clipId }); close(); }}>
        <span>Delete</span><kbd>⌫</kbd>
      </button>
    </div>
  );
}
