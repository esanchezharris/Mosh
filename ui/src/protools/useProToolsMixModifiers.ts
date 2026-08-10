import { useEffect, useState } from "react";
import type { ProToolsMixModifiers } from "./proToolsMixFanout";

const NONE: ProToolsMixModifiers = { altKey: false, shiftKey: false };

export function useProToolsMixModifiers(): ProToolsMixModifiers {
  const [modifiers, setModifiers] = useState<ProToolsMixModifiers>(NONE);

  useEffect(() => {
    const update = (event: KeyboardEvent) => setModifiers({
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    });
    const reset = () => setModifiers(NONE);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", reset);
    };
  }, []);

  return modifiers;
}
