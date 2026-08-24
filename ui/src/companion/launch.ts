import { parsePairing, type Pairing } from "./net";

export type CompanionLaunch =
  | { readonly kind: "mosh"; readonly pairing: Pairing }
  | { readonly kind: "ableton"; readonly token: string };

export class LaunchParseError extends Error {
  readonly name = "LaunchParseError";
  constructor(message: string) {
    super(message);
  }
}

export function consumeLaunch(href: string, clearVisibleUrl: (url: string) => void): CompanionLaunch {
  const url = new URL(href);
  const fragmentText = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (fragmentText.length > 0) {
    const fragment = new URLSearchParams(fragmentText);
    const token = fragment.get("token");
    const exactFragment = token !== null && fragmentText === `token=${encodeURIComponent(token)}`;
    if (url.pathname !== "/web" || url.search.length > 0 || !exactFragment || token.length === 0) {
      throw new LaunchParseError("Ableton pairing requires exactly /web#token=<nonempty>");
    }
    clearVisibleUrl(`${url.pathname}${url.search}`);
    return { kind: "ableton", token };
  }
  return { kind: "mosh", pairing: parsePairing(href) };
}
