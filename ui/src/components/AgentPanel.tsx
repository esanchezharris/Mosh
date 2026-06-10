import { useRef, useState } from "react";
import { useStore } from "../store";

type IROp = { kind: string; params: Record<string, unknown>; out?: string };
type Proposal = {
  ops: IROp[];
  rationale: string;
  provider: string;
  program_version: string;
  repaired?: boolean;
};
type ChatItem =
  | { role: "user"; text: string }
  | { role: "monster"; text: string; proposal?: Proposal }
  | { role: "system"; text: string };

/** Monster v0 — the B-5 operator slot (phase0 s10). Chat drawer: instruction
 *  → /agent/propose (validated MoshIR back) → op cards → one click executes
 *  through execute_ir, the same single mutation path as everything else, with
 *  createdBy=monster riding in the args for taste-label lineage. */
export function AgentPanel() {
  const exec = useStore((s) => s.exec);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const append = (item: ChatItem) =>
    setChat((c) => {
      const next = [...c, item];
      setTimeout(() => logRef.current?.scrollTo(0, 1e9), 0);
      return next;
    });

  const propose = async () => {
    const instruction = input.trim();
    if (!instruction || busy) return;
    setInput("");
    append({ role: "user", text: instruction });
    setBusy(true);
    try {
      const history = chat
        .filter((c) => c.role !== "system")
        .slice(-6)
        .map((c) => ({ role: c.role, text: c.text }));
      const r = await exec("agent_propose", { instruction, history });
      if (r.ok && r.data) {
        const p = r.data as unknown as Proposal;
        append({
          role: "monster",
          text: p.rationale || `${p.ops.length} ops proposed`,
          proposal: p,
        });
      } else {
        append({ role: "system", text: `✗ ${r.error ?? "agent failed"}` });
      }
    } finally {
      setBusy(false);
    }
  };

  const runOps = async (p: Proposal) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await exec("execute_ir", {
        ops: p.ops,
        actor: "monster",
        programVersion: p.program_version,
      });
      const counts = (r.data as { counts?: { executed: number; unsupported: number; failed: number } })
        ?.counts;
      append({
        role: "system",
        text: r.ok
          ? `✓ executed ${counts?.executed ?? "?"} ops` +
            (counts?.unsupported ? ` (${counts.unsupported} unsupported → gap ledger)` : "")
          : `✗ ${counts?.failed ?? "?"} op(s) failed — ${r.error ?? ""}`,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        className="tool-btn b5-live"
        onClick={() => setOpen(true)}
        title="Monster — the producer agent (B-5)"
      >
        B-5
      </button>
    );
  }

  return (
    <div className="agent-drawer">
      <div className="agent-head">
        <span className="agent-title">Monster</span>
        <button className="tool-btn" onClick={() => setOpen(false)} title="Collapse">×</button>
      </div>
      <div className="agent-log" ref={logRef}>
        {chat.length === 0 && (
          <div className="agent-hint">
            Tell Monster what to build — “8-bar trap drums at 142”, “send the keys
            to a reverb bus”, “dark 808 following the kick”…
          </div>
        )}
        {chat.map((c, i) => (
          <div key={i} className={`agent-msg agent-${c.role}`}>
            <div>{c.text}</div>
            {"proposal" in c && c.proposal && (
              <div className="agent-ops">
                {c.proposal.ops.map((op, j) => (
                  <div key={j} className="agent-op" title={JSON.stringify(op.params)}>
                    {op.kind}
                    {op.out ? ` → ${op.out}` : ""}
                  </div>
                ))}
                <button
                  className="tool-btn agent-run"
                  disabled={busy}
                  onClick={() => void runOps(c.proposal!)}
                >
                  ▶ Run {c.proposal.ops.length} ops
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="agent-input-row">
        <input
          className="tutorial-input agent-input"
          placeholder={busy ? "thinking…" : "instruction"}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void propose()}
        />
        <button className="tool-btn" disabled={busy} onClick={() => void propose()}>
          Propose
        </button>
      </div>
    </div>
  );
}
