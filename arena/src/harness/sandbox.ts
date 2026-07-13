// ============================================================================
// SANDBOX — model-authored candidate code is UNTRUSTED. This wraps every HTML
// candidate in a locked-down document and lint-gates every GLSL candidate.
//
// HTML: rendered via <iframe srcdoc sandbox="allow-scripts"> (NO allow-same-origin →
// opaque origin, no access to the arena's DOM/storage/cookies) + a strict CSP with
// connect-src 'none' (no fetch/XHR/websocket → can't exfiltrate or phone home). The
// wrapper ALWAYS supplies the CSP, the Mosh kit tokens, and the brand fonts, so a
// candidate can't strip them and every look is judged true-to-brand.
//
// GLSL: static loop-bound lint (reject unbounded / oversized / while loops) before it
// ever reaches a GL context; the renderer adds compile-isolation + a frame watchdog.
// ============================================================================

import fontsCss from "../kit/fonts.css?raw";
import moshiJs from "../kit/moshi.js?raw";
import { tokensCss, type Theme } from "../kit/tokens";

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; " +
  "script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

const RESET = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:var(--font-body);color:var(--v2-text);background:var(--v2-bg);
  -webkit-font-smoothing:antialiased;overflow:hidden}`;

// A tiny bridge so animated candidates can ride the shared transport clock. Candidates
// read window.__mosh (updated ~ per frame by postMessage from the parent).
const BRIDGE = `<script>
window.__mosh={time:0,playhead:0,playing:true};
addEventListener("message",function(e){var d=e.data;
  if(d&&d.type==="mosh-transport"){window.__mosh.time=d.time;window.__mosh.playhead=d.playhead;window.__mosh.playing=d.playing;}
});
<\/script>`;

/** If a model returns a whole document, pull out its body + styles so our wrapper's
 *  CSP/kit stay in control. Fragments pass through untouched. Links are dropped (no network). */
function normalizeToFragment(src: string): string {
  const s = src.trim();
  if (!/<html[\s>]/i.test(s) && !/<body[\s>]/i.test(s)) return s;
  const styles = [...s.matchAll(/<style[\s\S]*?<\/style>/gi)].map((m) => m[0]).join("\n");
  const bodyMatch = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : s;
  return `${styles}\n${body}`;
}

export interface WrapOpts {
  /** inject the real Moshi creature runtime so the candidate can call window.Moshi(...) */
  moshi?: boolean;
}

/** Build the complete, sandbox-ready srcdoc for an HTML candidate. */
export function wrapHtml(source: string, theme: Theme = "dark", opts: WrapOpts = {}): string {
  const fragment = normalizeToFragment(source);
  // The Moshi runtime is a 62KB zero-network global IIFE (window.Moshi); it runs fine
  // under this CSP (inline script, WebGL, no fetch). Injected only when the candidate opts in.
  const moshiRuntime = opts.moshi ? `<script>${moshiJs}<\/script>` : "";
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${fontsCss}</style>
<style>${tokensCss(theme)}</style>
<style>${RESET}</style>
</head><body>
${BRIDGE}
${moshiRuntime}
${fragment}
</body></html>`;
}

export const IFRAME_SANDBOX = "allow-scripts"; // deliberately NOT allow-same-origin

// ── GLSL loop-bound lint (spec §5.2): a candidate shader must have statically-bounded
// loops. We reject `while`, and any `for` whose terminating comparison isn't against a
// small integer literal (≤ CAP). Heuristic but conservative — reject rather than run.
const LOOP_CAP = 256;

export interface LintResult { ok: boolean; reason?: string }

export function lintShader(src: string): LintResult {
  if (/\bwhile\b/.test(src)) return { ok: false, reason: "while-loops are not allowed (unbounded)" };
  const forRe = /\bfor\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = forRe.exec(src))) {
    const header = m[1];
    // condition is the middle clause: init ; cond ; step
    const parts = header.split(";");
    if (parts.length < 2) return { ok: false, reason: "malformed for-loop header" };
    const cond = parts[1];
    // find an integer literal the loop compares against, e.g. i<64 / i <= 128
    const cmp = cond.match(/[<>]=?\s*([0-9]+)\b/);
    if (!cmp) return { ok: false, reason: `for-loop is not bounded by a constant: "${header.trim()}"` };
    const bound = parseInt(cmp[1], 10);
    if (bound > LOOP_CAP) return { ok: false, reason: `for-loop bound ${bound} exceeds cap ${LOOP_CAP}` };
  }
  if (!/void\s+main\s*\(/.test(src)) return { ok: false, reason: "shader has no main()" };
  return { ok: true };
}
