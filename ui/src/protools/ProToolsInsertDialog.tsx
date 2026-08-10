import { useEffect, useRef, useState, type RefObject } from "react";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useStore } from "../store";
import { PluginBrowserContent } from "../ui/PluginBrowser";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

type PluginQuarantine = { id: string; rawId: string; reason: string };

function quarantineName(entry: PluginQuarantine): string {
  return entry.rawId.split("/").at(-1) || entry.id;
}

export function ProToolsInsertDialog({ onClose, returnFocusRef, target = "track", trackIds }: {
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement>;
  readonly target?: "track" | "master";
  readonly trackIds?: readonly string[];
}) {
  const pluginCounts = useStore((state) => state.pluginCounts);
  const scanProgress = useStore((state) => state.scanProgress);
  const lastError = useStore((state) => state.lastError);
  const setLastError = useStore((state) => state.setLastError);
  const rescanPlugins = useStore((state) => state.rescanPlugins);
  const exec = useStore((state) => state.exec);
  const pluginBlocklist = useStore((state) => state.pluginBlocklist);
  const refreshPluginBlocklist = useStore((state) => state.refreshPluginBlocklist);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const dialogRef = useRef<HTMLElement>(null);
  const openedEpochRef = useRef(projectEpoch);
  const [scanAttempted, setScanAttempted] = useState(false);
  const quarantined = pluginBlocklist.filter((entry) =>
    entry.reason === "crash_or_hang" && entry.rawId.toLowerCase().endsWith(".vst3"));

  useEffect(() => pushEscapeHandler(onClose), [onClose]);
  useEffect(() => {
    if (projectEpoch !== openedEpochRef.current) onClose();
  }, [onClose, projectEpoch]);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>("[data-testid=plugin-browser-search]")?.focus();
    return () => returnFocusRef.current?.focus();
  }, [returnFocusRef]);
  useEffect(() => {
    if (scanProgress) return;
    void refreshPluginBlocklist();
  }, [refreshPluginBlocklist, scanProgress]);

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const rescanVst3 = async () => {
    setScanAttempted(true);
    setLastError(null);
    await rescanPlugins("vst3", false, true);
  };

  const retryQuarantined = async (entry: PluginQuarantine) => {
    setScanAttempted(true);
    setLastError(null);
    const result = await exec("unblock_plugin", { pluginId: entry.rawId });
    if (!result.ok) return;
    await refreshPluginBlocklist();
    await rescanPlugins("vst3", false, true);
  };

  return (
    <div className="pt-insert-backdrop" data-testid="pt-insert-backdrop" role="presentation" onClick={onClose}>
      <section ref={dialogRef} className="pt-insert-dialog" data-testid="pt-insert-dialog"
        role="dialog" aria-modal="true" aria-labelledby="pt-insert-title" tabIndex={-1}
        onClick={(event) => event.stopPropagation()} onKeyDown={trapFocus}>
        <header className="pt-insert-head">
          <div>
            <h2 id="pt-insert-title">
              {target === "master" ? "Add Master Insert"
                : trackIds && trackIds.length > 1 ? `Add Insert to ${trackIds.length} Channel Strips` : "Add Insert"}
            </h2>
            <span>{pluginCounts ? `${pluginCounts.vst3} VST3 available` : "Plugin catalog"}</span>
          </div>
          <button type="button" data-testid="pt-insert-rescan" disabled={Boolean(scanProgress)}
            title="Re-scan installed VST3 plugins out-of-process; hung plugins are quarantined"
            onClick={() => void rescanVst3()}>{scanProgress ? "Scanning…" : "Rescan VST3"}</button>
          <button type="button" data-testid="pt-insert-close" onClick={onClose}>Close</button>
        </header>
        {scanProgress && (
          <div className="pt-insert-scan" role="status" aria-live="polite">
            Scanning VST3
            {typeof scanProgress.count === "number" ? ` — ${scanProgress.count} found` : ""}
            {typeof scanProgress.elapsedMs === "number" ? ` · ${(scanProgress.elapsedMs / 1000).toFixed(1)}s` : ""}
            {" — hung plugins are quarantined"}
          </div>
        )}
        {!scanProgress && quarantined.length > 0 && (
          <div className="pt-insert-quarantine" role="status">
            {quarantined.map((entry, index) => (
              <div key={entry.rawId}>
                <span>Quarantined: {quarantineName(entry)}</span>
                <button type="button"
                  data-testid={index === 0 ? "pt-insert-retry-quarantine" : undefined}
                  onClick={() => void retryQuarantined(entry)}>
                  Retry this VST3
                </button>
              </div>
            ))}
          </div>
        )}
        {scanAttempted && lastError && <div className="pt-insert-error" role="alert">{lastError}</div>}
        <PluginBrowserContent onLoaded={onClose} loadTarget={target} trackIds={trackIds} />
      </section>
    </div>
  );
}
