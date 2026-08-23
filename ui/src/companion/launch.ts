import { parsePairing, type Pairing } from "./net";

export type CompanionLaunch =
  | { readonly kind: "mosh"; readonly pairing: Pairing }
  | { readonly kind: "ableton"; readonly token: string };

export class LaunchParseError extends Error {
  readonly name = "LaunchParseError";
}

export function consumeLaunch(href: string, clearVisibleUrl: (url: string) => void): CompanionLaunch {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if (fragment.has("token")) {
    const token = fragment.get("token");
    if (token === null || token.length === 0) {
      throw new LaunchParseError("Ableton pairing token is empty");
    }
    clearVisibleUrl(`${url.pathname}${url.search}`);
    return { kind: "ableton", token };
  }
  return { kind: "mosh", pairing: parsePairing(href) };
}
