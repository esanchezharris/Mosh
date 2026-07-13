import { useEffect, useState } from "react";
import { generate, getProviders, type Provider } from "../models/client";
import { arena } from "../library/store";
import { TARGETS, type Pass, type Target } from "../models/types";

const PASSES: Pass[] = ["elevate", "bolder"];

// Summon the model designers. Pick a target + which designers + which passes; the panel
// fires a generate() per (designer × pass), streaming candidates onto the wall as they
// land. Providers come from the proxy (only those with a key in .env.local show up).
export function GeneratePanel({ onClose, onToast, onMeter }: { onClose: () => void; onToast: (m: string) => void; onMeter: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [passes, setPasses] = useState<Set<Pass>>(new Set(PASSES));
  const [target, setTarget] = useState<Target>("shell");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    void getProviders().then((r) => {
      setProviders(r.providers);
      setChosen(new Set(r.providers.map((p) => p.id)));
    });
  }, []);

  const toggle = <T,>(set: Set<T>, v: T, setter: (s: Set<T>) => void) => {
    const n = new Set(set);
    n.has(v) ? n.delete(v) : n.add(v);
    setter(n);
  };

  const run = async () => {
    if (running) return;
    setRunning(true);
    setLog([]);
    const jobs: { provider: string; pass: Pass }[] = [];
    for (const p of chosen) for (const pass of passes) jobs.push({ provider: p, pass });
    let made = 0;
    for (const job of jobs) {
      setLog((l) => [...l, `${job.provider} · ${job.pass} …`]);
      const res = await generate({ provider: job.provider, target, pass: job.pass, theme: "dark" });
      onMeter();
      if (res.ok && res.candidate) {
        arena.addCandidates([res.candidate]);
        made++;
        setLog((l) => [...l.slice(0, -1), `${job.provider} · ${job.pass} ✓ ${res.ms ? `${res.ms}ms` : ""}`]);
      } else {
        setLog((l) => [...l.slice(0, -1), `${job.provider} · ${job.pass} ✕ ${res.error ?? "failed"}`]);
        if (res.error?.includes("cap")) break;
      }
    }
    setRunning(false);
    onToast(made ? `${made} new candidate${made > 1 ? "s" : ""} on the wall` : "no candidates generated");
  };

  const noProviders = providers.length === 0;

  return (
    <div className="gen-scrim" onClick={running ? undefined : onClose}>
      <div className="gen" onClick={(e) => e.stopPropagation()}>
        <div className="gen-head">
          <b>Summon designers</b>
          <button className="btn ghost" onClick={onClose} disabled={running}>✕</button>
        </div>
        <div className="gen-body">
          {noProviders ? (
            <div className="gen-note">
              No model designers configured yet. Add a key to <b>arena/.env.local</b> (see <b>.env.local.example</b>)
              and restart <code>npm run dev</code> — Claude, GPT, Gemini, and Grok each appear here once their key is set.
              The seed wall is fully judgeable without any keys.
            </div>
          ) : (
            <>
              <div>
                <div className="lab">Target</div>
                <select className="sel" value={target} onChange={(e) => setTarget(e.target.value as Target)}>
                  {TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <div className="lab">Designers</div>
                <div className="gen-row">
                  {providers.map((p) => (
                    <span key={p.id} className={`chip ${chosen.has(p.id) ? "on" : "off"}`} onClick={() => toggle(chosen, p.id, setChosen)}>
                      {p.label} · {p.model}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div className="lab">Passes</div>
                <div className="gen-row">
                  {PASSES.map((p) => (
                    <span key={p} className={`chip ${passes.has(p) ? "on" : "off"}`} onClick={() => toggle(passes, p, setPasses)}>
                      {p}
                    </span>
                  ))}
                </div>
              </div>
              {log.length > 0 && (
                <div className="gen-note" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
                  {log.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              )}
            </>
          )}
        </div>
        <div className="gen-foot">
          <button className="btn primary" disabled={running || noProviders || chosen.size === 0 || passes.size === 0} onClick={run}>
            {running ? <><span className="spin" /> generating…</> : `Generate ${chosen.size * passes.size} candidate${chosen.size * passes.size !== 1 ? "s" : ""}`}
          </button>
          <span className="gen-note">keys stay in .env.local · every call is metered + capped</span>
        </div>
      </div>
    </div>
  );
}
