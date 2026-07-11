import type { Preview } from "@storybook/react-vite";
import "../src/ui/mosh.css";
import "../src/v2/shell.css";

// Every story renders inside the app's real token cascade so Storybook is a faithful
// visual oracle for the design-system work: classic tokens live on `.app[data-theme]`
// (data-skin pinned to mosh, matching effects.ts), v2 tokens on `.v2-shell`. A toolbar
// global flips dark ↔ light (cream) so token sweeps can be snapshotted in both themes.
const preview: Preview = {
  parameters: { layout: "fullscreen" },
  globalTypes: {
    theme: {
      description: "Color theme",
      defaultValue: "dark",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: [
          { value: "dark", title: "Dark (Midnight Drive)" },
          { value: "light", title: "Light (cream)" },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, ctx) => {
      const theme = ctx.globals.theme ?? "dark";
      return (
        <div className="app" data-theme={theme} data-skin="mosh">
          {/* Real token scope, but layout props overridden so any story (not just the full
              shell) is scrollable and un-clipped — token *values* are unaffected. */}
          <div
            className="v2-shell"
            style={{ position: "static", inset: "auto", display: "block", overflow: "visible", minHeight: "100vh" }}
          >
            <Story />
          </div>
        </div>
      );
    },
  ],
};

export default preview;
