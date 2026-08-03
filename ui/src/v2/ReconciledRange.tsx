import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import type { CommandResult } from "../types";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange"> & {
  value: number;
  onCommit: (value: number) => Promise<CommandResult>;
  reconcile: () => Promise<number>;
};

/**
 * A snapshot-backed range that keeps the user's in-progress value locally until every
 * command in the current burst has settled, then re-reads the authoritative snapshot.
 *
 * A plain controlled range is unsafe here: native range gestures update the DOM first,
 * but React immediately restores the older snapshot prop while MoshOps invalidation is
 * still making its round trip. The next keyboard/AX step then starts from that stale
 * value and repeats or reverses. This component changes presentation only; every edit
 * still travels through the supplied MoshOps commit.
 */
export function ReconciledRange({ value, onCommit, reconcile, ...inputProps }: Props) {
  const [draft, setDraft] = useState(value);
  const valueRef = useRef(value);
  const commitRef = useRef(onCommit);
  const reconcileRef = useRef(reconcile);
  const generationRef = useRef(0);
  const inFlightRef = useRef(0);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  valueRef.current = value;
  commitRef.current = onCommit;
  reconcileRef.current = reconcile;

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    // Undo, agent edits, project reloads, and collaboration changes remain
    // authoritative whenever there is no local gesture awaiting reconciliation.
    if (!pendingRef.current) setDraft(value);
  }, [value]);

  const reconcileLatest = async (generation: number) => {
    let authoritative = valueRef.current;
    try {
      const refreshed = await reconcileRef.current();
      if (Number.isFinite(refreshed)) authoritative = refreshed;
    } catch {
      // refresh() owns connection/error reporting. Falling back to the last snapshot
      // keeps this control honest without creating a second error surface.
    }
    if (!mountedRef.current || generation !== generationRef.current || inFlightRef.current !== 0) return;
    pendingRef.current = false;
    setDraft(authoritative);
  };

  const commit = (next: number) => {
    generationRef.current += 1;
    pendingRef.current = true;
    inFlightRef.current += 1;
    setDraft(next);

    void (async () => {
      try {
        await commitRef.current(next);
      } catch {
        // A rejected bridge call and an ok:false result both reconcile from the
        // authoritative snapshot below; the store owns the user-facing error.
      } finally {
        inFlightRef.current -= 1;
        if (inFlightRef.current === 0) void reconcileLatest(generationRef.current);
      }
    })();
  };

  return (
    <input
      {...inputProps}
      type="range"
      value={draft}
      onChange={(event) => commit(Number(event.currentTarget.value))}
    />
  );
}
