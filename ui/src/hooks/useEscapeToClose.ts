import { useEffect } from "react";

// Close an open overlay when Escape is pressed. Mirrors the PianoRoll / popover
// behaviour so every modal in the app dismisses the same way (keyboard a11y +
// muscle memory). No-op while `active` is false, and self-cleaning.
export function useEscapeToClose(active: boolean, close: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, close]);
}
