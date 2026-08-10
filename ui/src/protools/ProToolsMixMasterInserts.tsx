import { useRef, useState } from "react";
import { useStore } from "../store";
import type { Plugin } from "../types";
import { ProToolsInsertDialog } from "./ProToolsInsertDialog";

const INSERT_SLOT_LABELS = ["A", "B", "C", "D", "E"] as const;

export function ProToolsMixMasterInserts({ plugins }: { readonly plugins: readonly Plugin[] }) {
  const exec = useStore((state) => state.exec);
  const addRef = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <section className="pt-mix-inserts pt-mix-master-inserts" data-testid="pt-mix-master-inserts"
      aria-label="Inserts on Master">
      <header>Inserts A–E</header>
      {INSERT_SLOT_LABELS.map((slot, slotIndex) => {
        const plugin = plugins[slotIndex];
        return plugin ? (
          <div className="pt-mix-insert-slot" key={slot} data-filled="true">
            <span className="pt-mix-slot-letter">{slot}</span>
            <button type="button" className="pt-mix-insert-name"
              data-testid={`pt-mix-master-insert-open-${plugin.index}`}
              title={`Open ${plugin.name}`}
              onClick={() => void exec("open_master_plugin_editor", { index: plugin.index })}>
              {plugin.name}
            </button>
            <button type="button" data-testid={`pt-mix-master-insert-bypass-${plugin.index}`}
              aria-label={`${plugin.enabled ? "Bypass" : "Enable"} ${plugin.name} on Master`}
              aria-pressed={!plugin.enabled}
              onClick={() => void exec("bypass_master_plugin", {
                index: plugin.index,
                bypassed: plugin.enabled,
              })}>P</button>
            <button type="button" data-testid={`pt-mix-master-insert-remove-${plugin.index}`}
              aria-label={`Remove ${plugin.name} from Master`}
              onClick={() => void exec("remove_master_plugin", { index: plugin.index })}>×</button>
          </div>
        ) : (
          <div className="pt-mix-insert-slot" key={slot} data-filled="false">
            <span className="pt-mix-slot-letter">{slot}</span><span>—</span>
          </div>
        );
      })}
      <button ref={addRef} type="button" className="pt-mix-add-insert"
        data-testid="pt-mix-master-add-insert" onClick={() => setDialogOpen(true)}>
        + Insert
      </button>
      {dialogOpen && (
        <ProToolsInsertDialog target="master" onClose={() => setDialogOpen(false)} returnFocusRef={addRef} />
      )}
    </section>
  );
}
