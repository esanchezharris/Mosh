import { useStore } from "../store";
import type { Snapshot } from "../types";
import { MasterMeter } from "../ui/Meter";
import { ReconciledRange } from "../v2/ReconciledRange";
import { ProToolsMixMasterInserts } from "./ProToolsMixMasterInserts";

const VOLUME_DEFAULT_DB = 0;
const PAN_DEFAULT = 0;

export function ProToolsMixMasterStrip({ snapshot }: { readonly snapshot: Snapshot }) {
  const exec = useStore((state) => state.exec);
  const master = snapshot.master;
  const volumeDb = master?.volumeDb ?? VOLUME_DEFAULT_DB;
  const pan = master?.pan ?? PAN_DEFAULT;

  const refreshMaster = async () => {
    await useStore.getState().refresh();
    return useStore.getState().snapshot?.master;
  };

  return (
    <section className="pt-mix-master-strip" data-testid="pt-mix-master-strip"
      aria-label="Master channel strip">
      <div className="pt-mix-strip-color" aria-hidden="true" />
      <ProToolsMixMasterInserts plugins={master?.plugins ?? []} />
      <div className="pt-mix-master-output"><span>Output</span><strong>Main</strong></div>
      <label className="pt-mix-pan">Pan
        <ReconciledRange min={-1} max={1} step={0.01} value={pan}
          data-testid="pt-mix-master-pan" aria-label="Pan for Master"
          onCommit={(nextPan) => exec("set_master_pan", { pan: nextPan })}
          reconcile={async () => (await refreshMaster())?.pan ?? PAN_DEFAULT}
          onDoubleClick={() => void exec("set_master_pan", { pan: PAN_DEFAULT })} />
        <output>{pan.toFixed(2)}</output>
      </label>
      <div className="pt-mix-meter-fader">
        <div className="pt-mix-master-meter" data-testid="pt-mix-master-meter"
          role="img" aria-label="Master live stereo level">
          <MasterMeter />
        </div>
        <label className="pt-mix-fader">Volume
          <ReconciledRange min={-70} max={6} step={0.5} value={volumeDb}
            data-testid="pt-mix-master-volume" aria-label="Volume for Master" aria-orientation="vertical"
            onCommit={(db) => exec("set_master_volume", { db })}
            reconcile={async () => (await refreshMaster())?.volumeDb ?? VOLUME_DEFAULT_DB}
            onDoubleClick={() => void exec("set_master_volume", { db: VOLUME_DEFAULT_DB })} />
        </label>
      </div>
      <output className="pt-mix-volume-readout">{volumeDb.toFixed(1)} dB</output>
      <div className="pt-mix-master-name"><span>Master</span><small>Mosh main bus</small></div>
    </section>
  );
}
