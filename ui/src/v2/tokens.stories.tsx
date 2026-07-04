// The token sheet — the standing visual oracle for the design-system work. It renders
// every --v2-* token as a labelled swatch (with its RESOLVED value), so a snapshot in
// dark + light catches any accidental value change from a token sweep (PR-2.4/2.5/2.6).
// Pure presentation, no store — safe to render anywhere inside the .v2-shell scope.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";

const COLOR_TOKENS = [
  "--v2-ink", "--v2-surface", "--v2-surface-2", "--v2-surface-sunken",
  "--v2-line", "--v2-line-strong", "--v2-text", "--v2-dim", "--v2-faint",
  "--v2-accent", "--v2-accent-ink", "--v2-accent-soft", "--v2-blue",
  "--v2-clip-midi", "--v2-clip-drum", "--v2-playhead", "--v2-rec",
  "--v2-ground", "--v2-ground-text", "--v2-ground-dim", "--v2-ground-card",
  "--v2-ground-line", "--v2-ground-line-strong",
];
const SPACE_TOKENS = ["--v2-space-1", "--v2-space-2", "--v2-space-3", "--v2-space-4", "--v2-space-5", "--v2-space-6", "--v2-space-7", "--v2-space-8"];
const RADIUS_TOKENS = ["--v2-radius-xs", "--v2-radius-sm", "--v2-radius-md", "--v2-radius", "--v2-radius-lg", "--v2-radius-pill"];
const FS_TOKENS = ["--v2-fs-2xs", "--v2-fs-xs", "--v2-fs-sm", "--v2-fs-base", "--v2-fs-md", "--v2-fs-lg", "--v2-fs-xl", "--v2-fs-display"];

function useResolved(names: string[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const n of names) out[n] = cs.getPropertyValue(n).trim();
    setVals(out);
  });
  return { ref, vals };
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "48px 1fr auto", gap: "var(--v2-space-6, 12px)", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--v2-line)" }}>{children}</div>;
}
function Label({ name, value }: { name: string; value: string }) {
  return (
    <>
      <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--v2-text)" }}>{name}</code>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--v2-dim)", justifySelf: "end", whiteSpace: "nowrap" }}>{value || "—"}</span>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h3 style={{ fontFamily: "var(--font-display)", color: "var(--v2-text)", fontSize: 15, textTransform: "uppercase", letterSpacing: "var(--v2-tracking-caps, 0.14em)", margin: "0 0 8px" }}>{title}</h3>
      {children}
    </section>
  );
}

function TokenSheet() {
  const colors = useResolved(COLOR_TOKENS);
  const spaces = useResolved(SPACE_TOKENS);
  const radii = useResolved(RADIUS_TOKENS);
  const fonts = useResolved(FS_TOKENS);
  return (
    <div style={{ padding: 32, background: "var(--v2-bg)", minHeight: "100vh", color: "var(--v2-text)", fontFamily: "var(--font-body)" }}>
      <h2 style={{ fontFamily: "var(--font-display)", margin: "0 0 4px" }}>v2 token sheet</h2>
      <p style={{ color: "var(--v2-dim)", margin: "0 0 24px", fontSize: 13 }}>Resolved <code>--v2-*</code> values. Flip the Theme toolbar to compare dark vs light — a token sweep must leave every swatch unchanged.</p>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1fr) minmax(320px, 1fr)", gap: 40 }}>
        <Section title="Color">
          <div ref={colors.ref}>
            {COLOR_TOKENS.map((n) => (
              <Row key={n}>
                <span style={{ width: 40, height: 24, borderRadius: 6, border: "1px solid var(--v2-line-strong)", background: `var(${n})` }} />
                <Label name={n} value={colors.vals[n]} />
              </Row>
            ))}
          </div>
        </Section>

        <div>
          <Section title="Spacing">
            <div ref={spaces.ref}>
              {SPACE_TOKENS.map((n) => (
                <Row key={n}>
                  <span style={{ height: 12, width: `var(${n})`, background: "var(--v2-accent)", borderRadius: 2 }} />
                  <Label name={n} value={spaces.vals[n]} />
                </Row>
              ))}
            </div>
          </Section>

          <Section title="Radius">
            <div ref={radii.ref}>
              {RADIUS_TOKENS.map((n) => (
                <Row key={n}>
                  <span style={{ width: 40, height: 24, background: "var(--v2-surface-2)", border: "1px solid var(--v2-line-strong)", borderRadius: `var(${n})` }} />
                  <Label name={n} value={radii.vals[n]} />
                </Row>
              ))}
            </div>
          </Section>

          <Section title="Type scale">
            <div ref={fonts.ref}>
              {FS_TOKENS.map((n) => (
                <Row key={n}>
                  <span aria-hidden style={{ fontSize: 12, color: "var(--v2-faint)" }}>Aa</span>
                  <span style={{ fontSize: `var(${n})`, color: "var(--v2-text)", lineHeight: 1 }}>The quick brown fox</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--v2-dim)", justifySelf: "end" }}>{fonts.vals[n] || "—"}</span>
                </Row>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Design System/Tokens",
  component: TokenSheet,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TokenSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Sheet: Story = {};
