import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { TrainingPanel, useTrainingForm, useTrainingToolsOpen } from "../ui/TopbarTools";
import { useV3 } from "./shellState";

// V3's way into LoRA training: the rights registry (add and approve sources), the way
// into the LoRA Lab, the library and the jobs. V3 is the default shell and had none of
// it, so a producer could not train, audition or keep a LoRA without switching shells.
// The body is the same TrainingPanel the v2 and classic popovers use; the chrome is V3's
// own modal (modal-root / scrim / modal glass / modal-hd / icon-x), like PhoneLauncher.
export function TrainingLauncher() {
  const open = useV3((s) => s.trainingOpen);
  const setOpen = useV3((s) => s.setTrainingOpen);
  const training = useStore((s) => s.snapshot?.training ?? null);
  // Owned here, and this component stays mounted while the dialog opens and closes, so
  // a half-filled source and the Build -> Train -> Import chain survive closing it.
  const form = useTrainingForm();
  const onOpen = useTrainingToolsOpen();
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);

  useEscapeToClose(open, close);
  useEffect(() => {
    if (!open) return;
    onOpen();
    closeRef.current?.focus();
  }, [open, onOpen]);

  if (!open) return null;
  return (
    <div className="modal-root" data-testid="v3-training-root">
      <div className="scrim" onClick={close} data-testid="v3-training-backdrop" />
      <div className="modal glass training-modal" role="dialog" aria-modal="true" aria-label="LoRA training"
        data-testid="v3-training-modal">
        <div className="modal-hd">
          <b>LoRA training</b>
          <button ref={closeRef} type="button" className="icon-x" aria-label="Close" onClick={close}>×</button>
        </div>
        <div className="modal-body training-body">
          <TrainingPanel training={training} form={form} onClose={close} />
        </div>
      </div>
    </div>
  );
}
