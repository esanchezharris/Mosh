// Coverage for the PR-2.5 sweep: renders the exact drifted consumers using their REAL
// shell.css classes, so the visual gate catches any pixel change when their raw literals
// are repointed to role tokens. Pure markup (no store). The spec forces --lvl / :hover /
// :focus-within so the glow/hover/focus declarations are exercised too.
import type { Meta, StoryObj } from "@storybook/react-vite";

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid var(--v2-line)", borderRadius: 10, minHeight: 80 }}>
      <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--v2-dim)" }}>{label}</code>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

function Consumers() {
  return (
    <div style={{ padding: 24, background: "var(--v2-bg)", minHeight: "100vh", color: "var(--v2-text)", fontFamily: "var(--font-body)" }}>
      <h2 style={{ fontFamily: "var(--font-display)", margin: "0 0 16px" }}>Drifted consumers (PR-2.5 sweep targets)</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(340px, 1fr))", gap: 12 }}>

        {/* lime glows (dynamic --lvl) */}
        <Cell label=".v2-lhead .v2-licon (glow @ --lvl:1)">
          <div className="v2-lhead" style={{ ["--lvl" as string]: 1, display: "flex", gap: 8, padding: 8 }}>
            <span className="v2-licon">≈</span>
          </div>
        </Cell>
        <Cell label=".v2-lane[data-track-id] (inset glow @ --lvl:1)">
          <div className="v2-lane" data-track-id="demo" style={{ ["--lvl" as string]: 1, width: 240, height: 44 }} />
        </Cell>

        {/* lime static */}
        <Cell label=".v2-clip.drum (bg + lime border)">
          <div className="v2-clip drum" style={{ position: "relative", width: 160, height: 40, borderRadius: 8, borderWidth: 1, borderStyle: "solid" }} />
        </Cell>
        <Cell label=".v2-pb-search (lime focus border — spec focuses input)">
          <div className="v2-pb-search" data-testid="pbsearch" style={{ display: "flex", padding: "6px 9px", border: "1px solid var(--v2-line)", borderRadius: 8, width: 220 }}>
            <input placeholder="search" data-testid="pbinput" style={{ background: "transparent", border: "none", outline: "none", color: "var(--v2-text)", font: "inherit" }} />
          </div>
        </Cell>

        {/* reds */}
        <Cell label=".v2-tbtn.rec[data-on] (rec glow = 2nd red)">
          <button className="v2-tbtn rec" data-on="true" style={{ padding: "6px 12px", borderRadius: 8, borderWidth: 1, borderStyle: "solid", background: "transparent" }}>● REC</button>
        </Cell>
        <Cell label=".v2-errbar (2nd red bg/border + #ffb3c1 text)">
          <div className="v2-errbar">Something went wrong.</div>
        </Cell>
        <Cell label=".v2-toast.err (rec-red border)">
          <div className="v2-toast err" style={{ padding: "8px 12px", borderWidth: 1, borderStyle: "solid", borderRadius: 10, background: "var(--v2-surface-2)" }}>Batch failed</div>
        </Cell>
        <Cell label=".v2-clipmenu button.danger (spec hovers it)">
          <div className="v2-clipmenu" style={{ padding: 6, background: "var(--v2-surface-2)", borderRadius: 8 }}>
            <button className="danger" data-testid="danger" style={{ padding: "6px 10px", background: "transparent", border: "none", color: "var(--v2-text)", borderRadius: 6 }}>Remove</button>
          </div>
        </Cell>

        {/* status */}
        <Cell label=".v2-flow-rhyme .st-none / .st-slant">
          <span className="v2-flow-rhyme st-none" style={{ padding: "2px 8px", borderWidth: 1, borderStyle: "solid", borderRadius: 6 }}>none</span>
          <span className="v2-flow-rhyme st-slant" style={{ padding: "2px 8px" }}>slant</span>
        </Cell>
        <Cell label=".v2-ms button.on.m (mute amber)">
          <span className="v2-ms"><button className="m on">M</button></span>
        </Cell>
        <Cell label=".v2-pcard-meta .dot (online green)">
          <div className="v2-pcard-meta" style={{ display: "flex", alignItems: "center" }}><span className="dot" /></div>
        </Cell>
      </div>
    </div>
  );
}

const meta = {
  title: "Design System/Consumers",
  component: Consumers,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Consumers>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Drifted: Story = {};
