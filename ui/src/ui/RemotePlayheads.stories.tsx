import type { Meta, StoryObj } from "@storybook/react-vite";
import { RemotePlayheadsView } from "./RemotePlayheads";
import type { PeerInfo, PeerPresence } from "../multiplayer/sync";

const peers: Record<string, PeerInfo> = {
  peerA: { name: "A", color: "#f06a8b", online: true },
};

const peerPresence: Record<string, PeerPresence> = {
  peerA: { position: 7.25, playing: true, recording: false, updatedAtMs: 2_000 },
};

const meta = {
  title: "Arrange/RemotePlayheads",
  component: RemotePlayheadsView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RemotePlayheadsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BSeesA: Story = {
  args: {
    secToPx: (seconds) => seconds * 48,
    lanesHeight: 220,
    peerPresence,
    peers,
    nowMs: 2_100,
  },
  render: (args) => (
    <div style={{ minHeight: "100vh", background: "#151515", padding: 24 }}>
      <div
        style={{
          position: "relative",
          height: 220,
          width: 720,
          maxWidth: "calc(100vw - 48px)",
          overflow: "hidden",
          border: "1px solid #2b2b2b",
          background:
            "repeating-linear-gradient(90deg, #222 0, #222 1px, transparent 1px, transparent 80px), linear-gradient(#191919, #101010)",
        }}
      >
        <div style={{ position: "absolute", left: 0, right: 0, top: 54, height: 1, background: "#2a2a2a" }} />
        <div style={{ position: "absolute", left: 0, right: 0, top: 110, height: 1, background: "#2a2a2a" }} />
        <div style={{ position: "absolute", left: 0, right: 0, top: 166, height: 1, background: "#2a2a2a" }} />
        <RemotePlayheadsView
          {...args}
        />
      </div>
    </div>
  ),
};
