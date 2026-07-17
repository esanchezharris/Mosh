// Persisted multiplayer identity (name + color) — UI-local, localStorage-backed, never
// crosses the bridge as anything but the per-call mpCreateSession/mpJoinSession args.
//
// Closes a real playtest bug: the one-click "Invite" affordances used to call
// mpCreateSession() with no name/color, so a producer's self-peer showed up nameless
// and colorless on the OTHER Mac. Remembering the last-used identity means a returning
// producer never retypes it, and a first-run producer still gets a non-empty default
// (never "") so the other side always sees a real name.

const STORAGE_KEY = "mosh.mp.identity";

// A small friendly palette (not the classic lime — this is a PEER color, shown on the
// other Mac's roster/avatar, so it should read distinctly from the app's own accent).
const DEFAULT_COLORS = ["#3aa0ff", "#e0457b", "#22c55e", "#f59e0b", "#a855f7", "#14b8a6"];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface MpIdentity {
  name: string;
  color: string;
}

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    // Some embedding contexts throw on access (privacy mode, sandboxed WebView).
    return null;
  }
}

function randomDefaultColor(): string {
  return DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)];
}

// Never returns a blank name — first run gets "Producer" rather than "", and a
// corrupted/partial persisted blob degrades field-by-field instead of failing whole.
export function loadMpIdentity(): MpIdentity {
  const s = storage();
  try {
    const raw = s?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MpIdentity>;
      const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Producer";
      const color = typeof parsed.color === "string" && HEX_RE.test(parsed.color) ? parsed.color : randomDefaultColor();
      return { name, color };
    }
  } catch {
    /* corrupt persisted blob -> fall through to a fresh default identity */
  }
  return { name: "Producer", color: randomDefaultColor() };
}

export function saveMpIdentity(identity: MpIdentity): void {
  const s = storage();
  try {
    s?.setItem(STORAGE_KEY, JSON.stringify({ name: identity.name, color: identity.color }));
  } catch {
    /* storage unavailable -> identity simply doesn't persist this session */
  }
}
