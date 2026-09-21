/**
 * Agent sprite engine — portable Grok-Bot-style body for multiplayer.
 *
 * Motion reconstructed from the official Grok Bot / bloub catalogue:
 * radial profiles, linear radius morphs, exponential ease-out (no spring),
 * pebble idle, independent blink + gaze, catalogue extras (dots, rings, badge).
 * The splat silhouette is a new skin, not one of the eight customiser shapes.
 *
 * engine.sample(t) is a PURE function of time. The clock lives in the caller.
 * No Date.now(), no rAF, no framework.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof define === "function" && define.amd) define(function () { return api; });
  root.AgentSprites = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TAU = Math.PI * 2;
  var PROFILE_SAMPLES = 64;
  var PEAK = 1.02;
  var TENSION = 1 / 6;
  /* Body silhouette only — lower than Catmull 1/6 so logo valleys aren't rounded away. */
  var BODY_TENSION = 0.14;
  /* Cap face placement so long lobes / deep valleys don't fling features to the rim. */
  var FACE_DISK = 0.85;
  var MORPH_DUR = 0.36;
  var BREATH_AMP = 0.005;
  var BREATH_PERIOD = 3.4;
  var BLINK_DUR = 0.32;
  var BLINK_CLOSE = 0.4;
  var BLINK_MIN = 2.4;
  var BLINK_MAX = 3.8;
  var BLINK_MID = 3.1;
  var MOUTH_GAP_MIN = 3.2;
  var MOUTH_GAP_MAX = 6.8;
  var MOUTH_GAP_MID = 5.0;
  var MOUTH_CLOSE_IN = 0.16;
  var MOUTH_CLOSE_HOLD = 0.07;
  var MOUTH_CLOSE_OUT = 0.22;
  var MOUTH_CLOSE_DUR = 0.45;
  var MOUTH_H_FLOOR = 0.008;
  var MOUTH_VOID_CUTOFF = 0.18;
  var MOUTH_CLOSED_W = 0.55;
  var NOTIF_POP = 1.14;
  var DOT_PULSE = 1.5;
  var DOT_STAGGER = 0.5;
  var DEG = Math.PI / 180;
  /* Idle lobe orbit: linear phase, arms slowly swapping (~24s/turn; calm). */
  var IDLE_ORBIT_PERIOD = 24.0;
  var IDLE_ORBIT_SPEED = (Math.PI * 2) / IDLE_ORBIT_PERIOD;
  /* Laugh activation: short elegant twist (~0.35 turns; under ~350ms morph). */
  var LAUGH_SPIN_TURNS = 0.35;
  var LAUGH_MORPH_DUR = 0.34;
  /* After laugh lands: quieter residual crawl (~1 turn / 120s). */
  var APEX_DRIFT_PERIOD = 120.0;
  var APEX_DRIFT_SPEED = (Math.PI * 2) / APEX_DRIFT_PERIOD;
  var SMILE_THICK = 0.112;
  var SMILE_CURVE = 0.34;

  var ANGLES = new Array(PROFILE_SAMPLES);
  var COS = new Array(PROFILE_SAMPLES);
  var SIN = new Array(PROFILE_SAMPLES);
  for (var i = 0; i < PROFILE_SAMPLES; i++) {
    var a = (i / PROFILE_SAMPLES) * TAU;
    ANGLES[i] = a;
    COS[i] = Math.cos(a);
    SIN[i] = Math.sin(a);
  }

  /* ------------------------------------------------------------------ */
  /*  Colour                                                            */
  /* ------------------------------------------------------------------ */

  var COLORWAYS = [
    { id: "encre",      name: "encre",      hex: "#1B1D1C", accent: "#C8FC0A", voidHex: "#070709" },
    { id: "creme",      name: "creme",      hex: "#F3EDE4", accent: "#0a0a0c", voidHex: "#2A1418" },
    { id: "carnaval",   name: "carnaval",   hex: "#3A5A7A", accent: "#D4A09E", voidHex: "#1A2426" },
    { id: "fools",      name: "fools",      hex: "#C8884A", accent: "#4A4A9A", voidHex: "#121428" },
    { id: "block",      name: "block",      hex: "#8BBAAA", accent: "#6B5A8A", voidHex: "#1A1420" },
    { id: "sea",        name: "sea",        hex: "#3A5A8A", accent: "#5A9A7A", voidHex: "#1A1014" },
    { id: "exhalation", name: "exhalation", hex: "#A86A8A", accent: "#C4B46A", voidHex: "#141228" },
    { id: "cruller",    name: "cruller",    hex: "#E4D48A", accent: "#B04A52", voidHex: "#141810" },
    { id: "sanctuary",  name: "sanctuary",  hex: "#3A282C", accent: "#B8A89A", voidHex: "#101614" },
    { id: "bodega",     name: "bodega",     hex: "#5A9AAA", accent: "#C47A72", voidHex: "#201014" },
    { id: "wallet",     name: "wallet",     hex: "#D4D47A", accent: "#4A6A8A", voidHex: "#1A1410" },
    { id: "passage",    name: "passage",    hex: "#3A2A48", accent: "#B04A4A", voidHex: "#181610" }
  ];

  var COLORWAY_BY_ID = {};
  for (var ci = 0; ci < COLORWAYS.length; ci++) {
    COLORWAY_BY_ID[COLORWAYS[ci].id] = COLORWAYS[ci];
  }

  var EYE_CREAM = "#f3f0e6";
  var INK = "#0a0a0c";
  var LIME = "#C8FC0A";

  function clamp01(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function fract(x) {
    return x - Math.floor(x);
  }

  function hash01(seed, i) {
    return fract(Math.sin((seed || 0) * 127.1 + (i || 0) * 311.7) * 43758.5453123);
  }

  var HEX_CACHE = Object.create(null);
  var RGBA_CACHE = Object.create(null);

  function parseHex(hex) {
    var key = String(hex || "");
    var hit = HEX_CACHE[key];
    if (hit) return hit;
    var h = key.charAt(0) === "#" ? key.slice(1) : key;
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    var n = parseInt(h, 16);
    var rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    HEX_CACHE[key] = rgb;
    return rgb;
  }

  function toHex(rgb) {
    return (
      "#" +
      rgb
        .map(function (x) {
          var v = Math.max(0, Math.min(255, Math.round(x)));
          return v.toString(16).padStart(2, "0");
        })
        .join("")
    );
  }

  function mixHex(from, to, t) {
    var a = parseHex(from);
    var b = parseHex(to);
    return toHex([
      lerp(a[0], b[0], t),
      lerp(a[1], b[1], t),
      lerp(a[2], b[2], t)
    ]);
  }

  function luminance(hex) {
    var c = parseHex(hex);
    return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  }

  var COLORWAY_RESOLVED = Object.create(null);

  function resolveColorway(input) {
    var cacheKey = null;
    if (!input) cacheKey = "encre";
    else if (typeof input === "string") cacheKey = COLORWAY_BY_ID[input] ? input : "encre";
    if (cacheKey && COLORWAY_RESOLVED[cacheKey]) return COLORWAY_RESOLVED[cacheKey];

    var row;
    if (!input) row = COLORWAY_BY_ID.encre;
    else if (typeof input === "string") row = COLORWAY_BY_ID[input] || COLORWAY_BY_ID.encre;
    else row = input;

    var body = row.hex || row.body || INK;
    var accent = row.accent || (luminance(body) < 0.42 ? LIME : INK);
    var dark = luminance(body) < 0.44;
    var eye = row.eye || (dark ? EYE_CREAM : INK);
    var accentDark = luminance(accent) < 0.40;
    var voidFill = row.voidHex || row.voidFill || row.void || (accentDark ? mixHex(accent, "#000000", 0.42) : "#070709");

    var resolved = {
      id: row.id || "custom",
      body: body,
      accent: accent,
      eye: eye,
      void: voidFill,
      voidHex: voidFill,
      dark: dark,
      highlight: dark ? mixHex(body, "#ffffff", 0.16) : mixHex(body, "#ffffff", 0.62),
      mid: dark ? mixHex(body, "#ffffff", 0.04) : mixHex(body, "#ffffff", 0.18),
      rim: dark ? mixHex(body, "#000000", 0.28) : mixHex(body, "#6d675c", 0.26),
      sheen: dark ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.48)",
      edge: dark ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.62)"
    };
    if (cacheKey) COLORWAY_RESOLVED[cacheKey] = resolved;
    return resolved;
  }

  /* ------------------------------------------------------------------ */
  /*  Profiles                                                          */
  /* ------------------------------------------------------------------ */

  function normalizeInto(radii, max, out) {
    max = max == null ? PEAK : max;
    var n = radii.length;
    var peak = 0;
    for (var i = 0; i < n; i++) if (radii[i] > peak) peak = radii[i];
    if (!out) out = new Array(n);
    if (peak <= 0) {
      if (out !== radii) for (var z = 0; z < n; z++) out[z] = radii[z];
      return out;
    }
    var k = max / peak;
    for (var j = 0; j < n; j++) out[j] = radii[j] * k;
    return out;
  }

  function normalize(radii, max) {
    return normalizeInto(radii, max, new Array(radii.length));
  }

  var SCRATCH_MIX_A = new Array(PROFILE_SAMPLES);
  var SCRATCH_MIX_B = new Array(PROFILE_SAMPLES);
  var SCRATCH_VISC = new Array(PROFILE_SAMPLES);
  var SCRATCH_PTS = new Array(PROFILE_SAMPLES);
  var DRAW_PTS = new Array(PROFILE_SAMPLES);
  (function initScratchPts() {
    for (var i = 0; i < PROFILE_SAMPLES; i++) {
      SCRATCH_PTS[i] = { x: 0, y: 0 };
      DRAW_PTS[i] = { x: 0, y: 0 };
    }
  })();

  /* Truth radial profiles — extracted from refs/truth/idle-encre.png & laugh-encre.png.
   * 64 samples, peak-normalised to PEAK. Image-space (phase 0 == still orientation).
   * Re-extract from stills; do not hand-tune. */
  var SPLAT_IDLE_TRUTH = [0.97823,0.97046,0.94811,0.91023,0.85874,0.79851,0.74703,0.75966,0.84126,0.91023,0.96074,0.99669,1.01514,1.02000,1.00737,0.97823,0.92966,0.86360,0.79171,0.78103,0.84029,0.90829,0.95200,0.97920,0.98503,0.97629,0.95297,0.91411,0.85680,0.77909,0.69554,0.65863,0.67514,0.74606,0.81891,0.88303,0.93549,0.97143,0.99280,1.00154,0.99183,0.96754,0.90537,0.85000,0.79366,0.86263,0.92771,0.97337,1.00251,1.00251,1.01223,0.99474,0.96366,0.91411,0.84903,0.77229,0.70331,0.68486,0.71206,0.77909,0.85000,0.90829,0.95006,0.97337];
  var SPLAT_LAUGH_TRUTH = [0.68125,0.63232,0.61539,0.62292,0.66526,0.77441,0.87792,0.94755,0.99083,1.01624,1.01812,1.00212,0.95978,0.88732,0.76500,0.60692,0.54293,0.51753,0.51282,0.52600,0.56458,0.70101,0.87980,0.96448,1.00589,1.02000,1.01059,0.97107,0.89673,0.74054,0.57116,0.53729,0.53164,0.56081,0.64832,0.82428,0.92496,0.97672,0.99365,0.97860,0.92779,0.81205,0.57681,0.56740,0.61068,0.70760,0.81205,0.88168,0.92214,0.93531,0.92779,0.89391,0.82710,0.70101,0.57399,0.53541,0.54858,0.82240,0.92685,0.96448,0.96637,0.93720,0.87415,0.77911];
  var TRUTH_IDLE_TIP = 0.06;
  var TRUTH_LAUGH_TIP = 0.14;

  function angWrap(d) {
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return d;
  }

  /* Kept for viscous / catalogue extras — not the silhouette source of truth. */
  var LOBE_ANGLES = [-1.72, -0.58, 0.78, 2.18, 3.55];
  var LOBE_WIDTHS = [0.98, 0.62, 0.92, 0.55, 0.80];

  function raisedLobe(d, halfWidth) {
    var ad = Math.abs(d);
    if (ad >= halfWidth) return 0;
    return 0.5 + 0.5 * Math.cos((Math.PI * ad) / halfWidth);
  }

  var SCRATCH_SPLAT_A = new Array(PROFILE_SAMPLES);
  var SCRATCH_SPLAT_B = new Array(PROFILE_SAMPLES);

  /** Rotate a radius profile by phase (positive = CW on screen / y-down). */
  function rotateRadiiInto(src, phase, out) {
    if (!out) out = new Array(PROFILE_SAMPLES);
    phase = phase || 0;
    if (Math.abs(phase) < 1e-12) {
      if (out !== src) for (var c = 0; c < PROFILE_SAMPLES; c++) out[c] = src[c];
      return out;
    }
    for (var i = 0; i < PROFILE_SAMPLES; i++) {
      out[i] = radiusAtAngle(src, ANGLES[i] - phase);
    }
    return out;
  }

  function rotateRadii(src, phase) {
    return rotateRadiiInto(src, phase, new Array(PROFILE_SAMPLES));
  }

  function splatProfileInto(phase, kind, out) {
    phase = phase == null ? 0 : phase;
    var src = kind === "laugh" ? SPLAT_LAUGH_TRUTH : SPLAT_IDLE_TRUTH;
    out = rotateRadiiInto(src, phase, out || new Array(PROFILE_SAMPLES));
    /* 3D depth (flat-lit): foreshortening + edge-on thinning + per-lobe breathe.
     * Idle stronger; laugh gentler so apex stays readable. */
    var near = kind === "laugh" ? 1.04 : 1.06;
    var far = kind === "laugh" ? 0.90 : 0.82;
    var edgeThin = kind === "laugh" ? 0.025 : 0.05;
    var lobePulse = kind === "laugh" ? 0.01 : 0.022;
    for (var di = 0; di < PROFILE_SAMPLES; di++) {
      var rel = ANGLES[di] - phase;
      var z = Math.cos(rel);
      out[di] *= lerp(far, near, 0.5 + 0.5 * z);
      var edge = Math.abs(Math.sin(rel));
      out[di] *= 1 - edgeThin * edge * edge;
      var pulse = 0;
      for (var L = 0; L < 5; L++) {
        var lobeAng = LOBE_ANGLES[L] + phase;
        var d = angWrap(ANGLES[di] - lobeAng);
        var env = raisedLobe(d, LOBE_WIDTHS[L] * 1.05);
        pulse += env * Math.sin(phase * 2.3 + L * 1.256);
      }
      out[di] *= 1 + lobePulse * pulse;
    }
    return out;
  }

  function splatProfile(phase, kind) {
    return splatProfileInto(phase, kind, new Array(PROFILE_SAMPLES));
  }

  function circleProfile(r) {
    r = r == null ? 1 : r;
    var out = new Array(PROFILE_SAMPLES);
    for (var i = 0; i < PROFILE_SAMPLES; i++) out[i] = r;
    return out;
  }

  /** Taller, narrower egg. r = 0.82 + 0.22·sin(θ)² then peak-normalised. */
  function eggProfile() {
    var radii = new Array(PROFILE_SAMPLES);
    for (var i = 0; i < PROFILE_SAMPLES; i++) {
      var s = SIN[i];
      radii[i] = 0.82 + 0.22 * s * s;
    }
    return normalize(radii, PEAK);
  }

  /** Rounded hex — six fat flats, corners pulled in. */
  function hexProfile() {
    var radii = new Array(PROFILE_SAMPLES);
    var n = 6;
    var sector = TAU / n;
    for (var i = 0; i < PROFILE_SAMPLES; i++) {
      var th = ANGLES[i];
      var local = ((th % sector) + sector) % sector - sector / 2;
      var flat = 0.90 / Math.max(Math.cos(local), 0.62);
      var corner = Math.pow(Math.abs(Math.sin(n * th)), 2.4);
      radii[i] = lerp(flat, 0.97, corner * 0.18);
    }
    return normalize(radii, PEAK);
  }

  var SPLAT = splatProfile(0);
  var SPLAT_LAUGH = splatProfile(0, "laugh");
  var CIRCLE = circleProfile(1);
  var EGG = eggProfile();
  var HEX = hexProfile();
  var THINK_DOT = circleProfile(0.18);
  var SLEEP_DOT = circleProfile(0.16);
  var BURST_DOT = circleProfile(0.17);

  function pebbleMod(angle, phi, psi) {
    return 1 + 0.075 * Math.cos(2 * angle + phi) + 0.035 * Math.cos(3 * angle + psi);
  }

  function applyPebble(base, phi, psi, amount) {
    return applyViscous(base, phi * 3.7, psi * 0.4, amount);
  }

  /**
   * Viscous idle: slow, overdamped, volume-ish conserved.
   * Traveling waves + out-of-phase lobe swell. No snap, no spring.
   */
  function applyViscousInto(base, t, seed, amount, out) {
    amount = amount == null ? 0 : amount;
    if (!out) out = new Array(PROFILE_SAMPLES);
    if (amount < 0.001) {
      if (out !== base) for (var c = 0; c < PROFILE_SAMPLES; c++) out[c] = base[c];
      return out;
    }
    var a = amount;
    var w1 = t * 0.72 + seed * 2.1;
    var w2 = t * 0.41 + seed * 3.4;
    var w3 = t * 0.95 + seed * 1.15;
    var w5 = t * 0.33 + seed * 0.7;
    for (var i = 0; i < PROFILE_SAMPLES; i++) {
      var th = ANGLES[i];
      var slosh =
        0.055 * Math.cos(th - w1) +
        0.036 * Math.cos(2 * th - w2) +
        0.022 * Math.cos(3 * th - w3) +
        0.016 * Math.cos(5 * th - w5);
      var lobe = 0;
      for (var L = 0; L < 5; L++) {
        var d = angWrap(th - LOBE_ANGLES[L]);
        var env = raisedLobe(d, LOBE_WIDTHS[L] * 1.15);
        lobe += env * Math.sin(t * (0.55 + L * 0.11) + seed * 1.7 + L * 1.256);
      }
      slosh += 0.024 * lobe;
      out[i] = base[i] * (1 + a * slosh);
    }
    return normalizeInto(out, PEAK, out);
  }

  function applyViscous(base, t, seed, amount) {
    return applyViscousInto(base, t, seed, amount, new Array(PROFILE_SAMPLES));
  }

  function mixProfilesInto(a, b, t, out) {
    if (!out) out = new Array(PROFILE_SAMPLES);
    for (var i = 0; i < PROFILE_SAMPLES; i++) out[i] = lerp(a[i], b[i], t);
    return out;
  }

  function mixProfiles(a, b, t) {
    return mixProfilesInto(a, b, t, new Array(PROFILE_SAMPLES));
  }

  function radiusAtAngle(radii, angle) {
    var n = radii.length;
    var t = ((((angle / TAU) % 1) + 1) % 1) * n;
    var i = Math.floor(t);
    return lerp(radii[i % n], radii[(i + 1) % n], t - i);
  }

  var PROFILE_CACHE = {
    egg: EGG,
    hex: HEX,
    hexagon: HEX,
    think: THINK_DOT,
    thinking: THINK_DOT,
    sleep: SLEEP_DOT,
    burst: SPLAT,
    laugh: SPLAT_LAUGH,
    splat: SPLAT
  };

  function profileFor(name) {
    return PROFILE_CACHE[name] || SPLAT;
  }

  /* ------------------------------------------------------------------ */
  /*  Ease / path                                                       */
  /* ------------------------------------------------------------------ */

  /** Exponential ease-out. Body never overshoots (no spring). */
  function easeOutExp(t) {
    t = clamp01(t);
    if (t === 1) return 1;
    return 1 - Math.exp(-6.2 * t);
  }

  function easeInOut(t) {
    t = clamp01(t);
    return 0.5 - 0.5 * Math.cos(t * Math.PI);
  }

  function r4(n) {
    return Math.round(n * 10000) / 10000;
  }

  function toPointsInto(radii, pose, scale, out) {
    scale = scale == null ? 1 : scale;
    var cr = Math.cos(pose.rot || 0);
    var sr = Math.sin(pose.rot || 0);
    var sx = pose.sx == null ? 1 : pose.sx;
    var sy = pose.sy == null ? 1 : pose.sy;
    var cx = pose.cx || 0;
    var cy = pose.cy || 0;
    if (!out) out = new Array(PROFILE_SAMPLES);
    for (var i = 0; i < PROFILE_SAMPLES; i++) {
      var r = radii[i];
      var x = r * COS[i];
      var y = r * SIN[i];
      var rx = x * cr - y * sr;
      var ry = x * sr + y * cr;
      var p = out[i] || (out[i] = { x: 0, y: 0 });
      p.x = (rx * sx + cx) * scale;
      p.y = (ry * sy + cy) * scale;
    }
    return out;
  }

  function toPoints(radii, pose, scale) {
    var pts = new Array(PROFILE_SAMPLES);
    for (var i = 0; i < PROFILE_SAMPLES; i++) pts[i] = { x: 0, y: 0 };
    return toPointsInto(radii, pose, scale, pts);
  }

  function closedPath(pts, tension) {
    tension = tension == null ? TENSION : tension;
    var n = pts.length;
    if (n < 3) return "";
    var d = "M" + r4(pts[0].x) + " " + r4(pts[0].y);
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n];
      var p1 = pts[i];
      var p2 = pts[(i + 1) % n];
      var p3 = pts[(i + 2) % n];
      d +=
        "C" +
        r4(p1.x + (p2.x - p0.x) * tension) +
        " " +
        r4(p1.y + (p2.y - p0.y) * tension) +
        " " +
        r4(p2.x - (p3.x - p1.x) * tension) +
        " " +
        r4(p2.y - (p3.y - p1.y) * tension) +
        " " +
        r4(p2.x) +
        " " +
        r4(p2.y);
    }
    return d + "Z";
  }

  function placeOnBody(x, y, radii) {
    var ang = Math.atan2(y, x);
    var edge = radiusAtAngle(radii, ang);
    var r = Math.min(edge, FACE_DISK);
    return { x: x * r, y: y * r, angle: ang, edge: edge, faceR: r };
  }

  function posePoint(x, y, pose) {
    var sx = pose.sx == null ? 1 : pose.sx;
    var sy = pose.sy == null ? 1 : pose.sy;
    var px = x * sx;
    var py = y * sy;
    var cr = Math.cos(pose.rot || 0);
    var sr = Math.sin(pose.rot || 0);
    return {
      x: px * cr - py * sr + (pose.cx || 0),
      y: px * sr + py * cr + (pose.cy || 0)
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Blink + gaze (independent of body)                                */
  /* ------------------------------------------------------------------ */

  function blinkEnvelope(u) {
    u = clamp01(u);
    if (u <= 0 || u >= 1) return 0;
    if (u < BLINK_CLOSE) return easeOutExp(u / BLINK_CLOSE);
    return 1 - easeOutExp((u - BLINK_CLOSE) / (1 - BLINK_CLOSE));
  }

  /**
   * Closed amount 0..1. Pure in (t, seed).
   * 320ms blink, ~40% close / 60% open. Idle gap 2.4–3.8s, seeded.
   */
  function blinkAmount(t, seed) {
    if (typeof t !== "number" || !isFinite(t)) return 0;
    seed = seed || 0;
    var phase = hash01(seed, 1) * BLINK_MID;
    var idx = Math.floor((t + phase) / BLINK_MID);
    var best = 0;
    for (var k = -2; k <= 2; k++) {
      var i = idx + k;
      var start = i * BLINK_MID + (hash01(seed, i + 4) - 0.5) * (BLINK_MAX - BLINK_MIN) - phase;
      var local = t - start;
      if (local >= 0 && local <= BLINK_DUR) {
        var b = blinkEnvelope(local / BLINK_DUR);
        if (b > best) best = b;
      }
    }
    return best;
  }

  function mouthCloseEnvelope(local) {
    if (local <= 0 || local >= MOUTH_CLOSE_DUR) return 1;
    if (local < MOUTH_CLOSE_IN) return 1 - easeInOut(local / MOUTH_CLOSE_IN);
    if (local < MOUTH_CLOSE_IN + MOUTH_CLOSE_HOLD) return 0;
    return easeInOut((local - MOUTH_CLOSE_IN - MOUTH_CLOSE_HOLD) / MOUTH_CLOSE_OUT);
  }

  /**
   * Open amount 0..1. Pure in (t, seed). 0 = closed slit, 1 = full D.
   * Default is closed. Laugh (and world.mouthOpen) drive opening in sample().
   */
  function mouthOpenAmount(t, seed) {
    return 0;
  }

  /** Rest wander: almost still, ~±1.1° yaw, ±0.75° pitch (~half prior quiet). */
  function gazeWander(t, seed) {
    seed = seed || 0;
    var w = t * 0.55 + seed * 3.1;
    return {
      yaw: 1.1 * Math.sin(w) + 0.2 * Math.sin(w * 0.41 + seed),
      pitch: 0.75 * Math.sin(2 * w + 0.3)
    };
  }

  function resolveGaze(def, t, seed) {
    var wander = gazeWander(t, seed);
    if (!def || def.gaze == null) return wander;
    if (def.gaze === "spin") {
      var ang = t * 1.45 + seed * 2;
      return { yaw: Math.cos(ang) * 16, pitch: Math.sin(ang) * 10 };
    }
    return {
      yaw: def.gaze.yaw,
      pitch: def.gaze.pitch
    };
  }

  function gazeToGlance(g) {
    return {
      x: (g.yaw || 0) * DEG * 0.72,
      y: (g.pitch || 0) * DEG * 0.72
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Face marks                                                        */
  /* ------------------------------------------------------------------ */

  /** Rotate (x,y) around (cx,cy) by rot radians (screen y-down → CW positive). */
  function rotAround(x, y, cx, cy, rot) {
    if (!rot) return { x: x, y: y };
    var c = Math.cos(rot);
    var s = Math.sin(rot);
    var dx = x - cx;
    var dy = y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  }

  function squintMark(cx, cy, side, s, open, rot) {
    var w = 0.062 * s;
    var h = 0.078 * s;
    var gap = 0.012 * open;
    var dir = -side;
    var x0 = cx - dir * w;
    var x1 = cx + dir * (w * 0.18);
    var p0 = rotAround(x0, cy - h, cx, cy, rot);
    var p1 = rotAround(x1, cy - gap, cx, cy, rot);
    var p2 = rotAround(x0, cy + h, cx, cy, rot);
    return {
      kind: "squint",
      width: 0.058,
      d:
        "M" +
        r4(p0.x) +
        " " +
        r4(p0.y) +
        "L" +
        r4(p1.x) +
        " " +
        r4(p1.y) +
        "L" +
        r4(p2.x) +
        " " +
        r4(p2.y),
      cx: cx,
      cy: cy,
      rot: rot || 0
    };
  }

  function ovalEye(cx, cy, rx, ry, rot) {
    rx = Math.max(0.001, rx);
    ry = Math.max(0.001, ry);
    rot = rot || 0;
    var deg = (rot * 180) / Math.PI;
    var left = rotAround(cx - rx, cy, cx, cy, rot);
    var right = rotAround(cx + rx, cy, cx, cy, rot);
    return {
      kind: "oval",
      cx: cx,
      cy: cy,
      rx: rx,
      ry: ry,
      rot: rot,
      d:
        "M" +
        r4(left.x) +
        " " +
        r4(left.y) +
        "A" +
        r4(rx) +
        " " +
        r4(ry) +
        " " +
        r4(deg) +
        " 1 0 " +
        r4(right.x) +
        " " +
        r4(right.y) +
        "A" +
        r4(rx) +
        " " +
        r4(ry) +
        " " +
        r4(deg) +
        " 1 0 " +
        r4(left.x) +
        " " +
        r4(left.y) +
        "Z"
    };
  }

  function dashEye(cx, cy, w, rot) {
    w = w == null ? 0.072 : w;
    var a = rotAround(cx - w, cy, cx, cy, rot);
    var b = rotAround(cx + w, cy, cx, cy, rot);
    return {
      kind: "dash",
      width: 0.044,
      d: "M" + r4(a.x) + " " + r4(a.y) + "L" + r4(b.x) + " " + r4(b.y),
      cx: cx,
      cy: cy,
      rot: rot || 0
    };
  }

  function mouthD(cx, cy, w, h, rot) {
    /* Open D: flat top, smooth U. Geometry rotates with body roll. */
    w = Math.max(0.001, w);
    h = Math.max(0.001, h);
    rot = rot || 0;
    var top = cy;
    var bot = cy + h;
    var midY = lerp(top, bot, 0.62);
    function P(x, y) {
      return rotAround(x, y, cx, cy, rot);
    }
    var p0 = P(cx - w, top);
    var p1 = P(cx + w, top);
    var c1 = P(cx + w, midY);
    var c2 = P(cx + w * 0.62, bot);
    var p2 = P(cx, bot);
    var c3 = P(cx - w * 0.62, bot);
    var c4 = P(cx - w, midY);
    var d =
      "M" + r4(p0.x) + " " + r4(p0.y) +
      "L" + r4(p1.x) + " " + r4(p1.y) +
      "C" + r4(c1.x) + " " + r4(c1.y) +
      " " + r4(c2.x) + " " + r4(c2.y) +
      " " + r4(p2.x) + " " + r4(p2.y) +
      "C" + r4(c3.x) + " " + r4(c3.y) +
      " " + r4(c4.x) + " " + r4(c4.y) +
      " " + r4(p0.x) + " " + r4(p0.y) +
      "Z";
    var vr = w * 0.26;
    var vry = h * 0.28;
    var vpt = P(cx, cy + h * 0.78);
    return {
      d: d,
      cx: cx,
      cy: cy,
      w: w,
      h: h,
      rot: rot,
      smile: false,
      /* Top semicircle tongue/void — bulge toward eyes, chord on lip (not goatee). */
      void: { kind: "semi", cx: vpt.x, cy: vpt.y, rx: vr, ry: vry, rot: rot }
    };
  }

  /**
   * Closed lime smile: thick curved capsule (slight ∪), not a flat slit / open D.
   * w = half-width, thick = vertical thickness of the capsule.
   */
  function mouthSmile(cx, cy, w, thick, rot, curve) {
    /* Thick short bent capsule. Path is stroke-outline for SVG; canvas strokes the centerline. */
    w = Math.max(0.001, w);
    thick = Math.max(0.028, thick == null ? SMILE_THICK : thick);
    rot = rot || 0;
    curve = curve == null ? SMILE_CURVE : curve;
    var dip = w * curve;
    var half = thick * 0.5;
    function P(x, y) {
      return rotAround(x, y, cx, cy, rot);
    }
    /* Desired midpoints of top/bottom arcs (Q control is NOT on-curve). */
    var midTopY = cy + dip - half;
    var midBotY = cy + dip + half;
    var cTopY = 2 * midTopY - cy; /* since ends ≈ cy */
    var cBotY = 2 * midBotY - cy;
    var pLi = P(cx - w, cy);
    var pRi = P(cx + w, cy);
    var pLo = P(cx - w, cy);
    var pRo = P(cx + w, cy);
    var cTop = P(cx, cTopY);
    var cBot = P(cx, cBotY);
    var cR = P(cx + w + half, cy + dip * 0.3);
    var cL = P(cx - w - half, cy + dip * 0.3);
    var d =
      "M" + r4(pLi.x) + " " + r4(pLi.y) +
      "Q" + r4(cTop.x) + " " + r4(cTop.y) + " " + r4(pRi.x) + " " + r4(pRi.y) +
      "Q" + r4(cR.x) + " " + r4(cR.y) + " " + r4(pRo.x) + " " + r4(pRo.y) +
      "Q" + r4(cBot.x) + " " + r4(cBot.y) + " " + r4(pLo.x) + " " + r4(pLo.y) +
      "Q" + r4(cL.x) + " " + r4(cL.y) + " " + r4(pLi.x) + " " + r4(pLi.y) +
      "Z";
    return {
      d: d,
      cx: cx,
      cy: cy,
      w: w,
      h: thick,
      rot: rot,
      curve: curve,
      smile: true,
      void: { kind: "semi", cx: cx, cy: cy, rx: 0, ry: 0, rot: rot }
    };
  }

  function face(extra) {
    var o = {
      body: "splat",
      eyeKind: "oval",
      eyeX: 0.3,
      eyeY: -0.16,
      eyeRx: 0.056,
      eyeRy: 0.07,
      mouthW: 0.175,
      mouthH: 0.13,
      mouthY: 0.18,
      pebble: 0.22,
      eyeAlpha: 1,
      eyeScale: 1,
      roll: 0,
      towardCircle: 0,
      blinkIn: false,
      gaze: null,
      extras: null,
      winkLeft: 0
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
    return o;
  }

  var STATE_DEFS = {
    idle: face({
      duration: 4.2,
      morph: 0.36,
      pebble: 0.02,
      roll: TRUTH_IDLE_TIP,
      eyeKind: "oval",
      eyeX: 0.325,
      eyeY: -0.12,
      eyeRx: 0.038,
      eyeRy: 0.088,
      mouthW: 0.135,
      mouthH: 0.13,
      mouthY: 0.145
    }),
    thinking: face({
      duration: 2.6,
      morph: 0.4,
      body: "thinking",
      pebble: 0.06,
      eyeAlpha: 0,
      eyeScale: 0.2,
      mouthW: 0.06,
      mouthH: 0.04,
      blinkIn: true,
      extras: "think"
    }),
    wink: face({
      duration: 1.6,
      morph: 0.3,
      eyeKind: "wink",
      eyeRx: 0.058,
      eyeRy: 0.074,
      mouthW: 0.17,
      mouthH: 0.1,
      roll: 0.14,
      blinkIn: true,
      gaze: { yaw: 12, pitch: 1 },
      extras: "wink"
    }),
    wide: face({
      duration: 1.8,
      morph: 0.55,
      eyeKind: "oval",
      eyeX: 0.312,
      eyeRx: 0.07,
      eyeRy: 0.122,
      mouthW: 0.15,
      mouthH: 0.16,
      mouthY: 0.15,
      pebble: 0.3,
      blinkIn: true,
      gaze: { yaw: 10, pitch: 12 }
    }),
    laugh: face({
      duration: 1.7,
      morph: LAUGH_MORPH_DUR,
      body: "laugh",
      eyeKind: "squint",
      eyeX: 0.220,
      eyeY: -0.14,
      eyeRx: 0.052,
      eyeRy: 0.060,
      mouthW: 0.200,
      mouthH: 0.250,
      mouthY: 0.120,
      pebble: 0.05,
      roll: TRUTH_LAUGH_TIP
    }),
    notify: face({
      duration: 2.2,
      morph: 0.5,
      eyeKind: "oval",
      eyeRx: 0.066,
      eyeRy: 0.068,
      mouthW: 0.14,
      mouthH: 0.1,
      pebble: 0.32,
      blinkIn: true,
      gaze: { yaw: -13, pitch: 5 },
      extras: "notify"
    }),
    egg: face({
      duration: 1.8,
      morph: 0.5,
      body: "egg",
      eyeX: 0.26,
      eyeY: -0.2,
      eyeRx: 0.044,
      eyeRy: 0.054,
      eyeScale: 0.78,
      mouthW: 0.16,
      mouthH: 0.1,
      pebble: 0.16,
      blinkIn: true,
      gaze: { yaw: 10, pitch: -10 }
    }),
    hexagon: face({
      duration: 1.6,
      morph: 0.48,
      body: "hexagon",
      eyeX: 0.28,
      eyeRx: 0.048,
      eyeRy: 0.06,
      eyeScale: 0.86,
      mouthW: 0.17,
      mouthH: 0.11,
      pebble: 0.1,
      blinkIn: true
    }),
    orbit: face({
      duration: 3.4,
      morph: 0.6,
      pebble: 0.22,
      blinkIn: true,
      gaze: "spin",
      extras: "orbit"
    }),
    burst: face({
      duration: 2.6,
      morph: 0.45,
      body: "burst",
      pebble: 0.12,
      eyeAlpha: 0,
      mouthW: 0.1,
      mouthH: 0.07,
      extras: "burst"
    }),
    sleep: face({
      duration: 2.4,
      morph: 0.55,
      body: "sleep",
      pebble: 0.04,
      eyeAlpha: 0,
      extras: "sleep"
    })
  };

  var SEQUENCE = [
    "idle",
    "thinking",
    "wink",
    "wide",
    "laugh",
    "notify",
    "egg",
    "hexagon",
    "orbit",
    "burst",
    "sleep"
  ];

  var STATES = SEQUENCE.slice();

  var SEQUENCE_DUR = 0;
  var SEQUENCE_OFFSETS = [];
  for (var si = 0; si < SEQUENCE.length; si++) {
    SEQUENCE_OFFSETS.push(SEQUENCE_DUR);
    SEQUENCE_DUR += STATE_DEFS[SEQUENCE[si]].duration;
  }

  function resolveState(name) {
    if (name === "speak" || name === "speaking" || name === "happy") return "laugh";
    if (name === "think" || name === "listen") return "thinking";
    if (name === "hex") return "hexagon";
    if (STATE_DEFS[name]) return name;
    return "idle";
  }

  var BLEND_KEYS = [
    "eyeX",
    "eyeY",
    "eyeRx",
    "eyeRy",
    "mouthW",
    "mouthH",
    "mouthY",
    "pebble",
    "eyeAlpha",
    "eyeScale",
    "roll",
    "towardCircle"
  ];

  function blendExpr(a, b, t) {
    var out = {};
    for (var i = 0; i < BLEND_KEYS.length; i++) {
      var k = BLEND_KEYS[i];
      var av = a[k] == null ? 0 : a[k];
      var bv = b[k] == null ? 0 : b[k];
      out[k] = lerp(av, bv, t);
    }
    out.eyeKind = t < 0.42 ? a.eyeKind : b.eyeKind;
    out.body = t < 0.5 ? a.body : b.body;
    out.extras = t < 0.5 ? a.extras : b.extras;
    out.blinkIn = b.blinkIn;
    out.gaze = b.gaze;
    out.winkLeft = t < 0.5 ? a.winkLeft : b.winkLeft;
    out.id = t < 0.5 ? a.id : b.id;
    return out;
  }

  function notifPop(local) {
    if (local <= 0) return 0;
    if (local < 0.28) return easeOutExp(local / 0.28) * NOTIF_POP;
    return lerp(NOTIF_POP, 1, easeOutExp(clamp01((local - 0.28) / 0.45)));
  }

  function burstCollapse(local) {
    if (local <= 0) return 0;
    if (local < 0.72) return easeOutExp(local / 0.72);
    if (local < 1.12) return 1;
    return 1 - easeOutExp(clamp01((local - 1.12) / 1.18));
  }

  function thinkPulse(t, delay) {
    var u = (((t - delay) % DOT_PULSE) + DOT_PULSE) % DOT_PULSE / DOT_PULSE;
    return 0.5 - 0.5 * Math.cos(u * TAU);
  }

  /* ------------------------------------------------------------------ */
  /*  sample(t)                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Pure sample. `t` is seconds from an arbitrary origin supplied by the caller.
   * `world` is the declared pose, never read from the clock:
   *   { colorway, state, prevState, changedAt, seed, morphDur, mouthOpen }
   */
  function sample(t, world) {
    if (typeof t !== "number" || !isFinite(t)) {
      throw new Error("sample(t) requires a finite time in seconds");
    }
    world = world || {};
    var colorway = resolveColorway(world.colorway);
    var state = resolveState(world.state || "idle");
    var prevState = resolveState(world.prevState || state);
    var changedAt = typeof world.changedAt === "number" ? world.changedAt : t;
    var seed = world.seed || 0;
    var toDef = STATE_DEFS[state];
    var fromDef = STATE_DEFS[prevState];
    var morphDur = world.morphDur || toDef.morph || MORPH_DUR;
    if (!world.morphDur && (state === "laugh" || prevState === "laugh")) {
      morphDur = toDef.morph || LAUGH_MORPH_DUR;
    }

    var u = easeOutExp((t - changedAt) / morphDur);
    if (state === prevState) u = 1;

    var expr = blendExpr(fromDef, toDef, u);
    expr.id = u < 0.5 ? prevState : state;

    var local = t - changedAt;
    var phi = 0.5 + 0.27 * t + seed * 1.7;
    var psi = 2.1 + 0.17 * t + seed * 2.3;

    /* Lobe orbit phase — independent of face tip (pose.rot / faceRoll). */
    var reduced = !!(world.reducedMotion || world.reduced);
    var seedOffset = seed === 0 ? 0 : hash01(seed, 3) * TAU;
    var idlePhase = reduced ? seedOffset : t * IDLE_ORBIT_SPEED + seedOffset;
    var idlePhaseAtChange = reduced ? seedOffset : changedAt * IDLE_ORBIT_SPEED + seedOffset;
    var lobePhase = idlePhase;
    var landPhase = 0; /* laugh truth still orientation */
    /* Shortest path onto landPhase (0 = truth still). Face uses (phase−land). */
    var laughSpinAmt = 0;
    var laughSpinU = 1;
    if (state === "laugh") {
      laughSpinU = easeOutExp(clamp01((t - changedAt) / Math.max(1e-6, morphDur)));
      if (reduced) {
        lobePhase = landPhase;
      } else {
        var delta = landPhase - idlePhaseAtChange;
        delta = delta - TAU * Math.floor((delta + Math.PI) / TAU); /* (-π, π] */
        /* Already on truth: morph/squash carries enter; no fake spin (avoids land snap). */
        laughSpinAmt = delta;
        lobePhase = idlePhaseAtChange + laughSpinAmt * laughSpinU;
        if (laughSpinU >= 1) {
          var sinceLand = Math.max(0, t - (changedAt + morphDur));
          lobePhase = landPhase + sinceLand * APEX_DRIFT_SPEED;
        }
      }
    } else if (prevState === "laugh" && u < 1) {
      laughSpinU = easeOutExp(clamp01((t - changedAt) / Math.max(1e-6, morphDur)));
      if (reduced) {
        lobePhase = idlePhase;
      } else {
        var startLeave = landPhase;
        if (typeof world.laughChangedAt === "number" && isFinite(world.laughChangedAt)) {
          var landAt = world.laughChangedAt + (typeof world.laughMorphDur === "number" ? world.laughMorphDur : LAUGH_MORPH_DUR);
          startLeave = landPhase + Math.max(0, changedAt - landAt) * APEX_DRIFT_SPEED;
        }
        var idleAtEnd = idlePhaseAtChange + morphDur * IDLE_ORBIT_SPEED;
        var leaveDelta = idleAtEnd - startLeave;
        leaveDelta = leaveDelta - TAU * Math.floor((leaveDelta + Math.PI) / TAU);
        laughSpinAmt = leaveDelta;
        lobePhase = startLeave + leaveDelta * laughSpinU;
      }
    }

    if (typeof world.lobePhase === "number" && isFinite(world.lobePhase)) {
      lobePhase = world.lobePhase;
    }

    function liveBody(name, phase, scratch) {
      if (name === "laugh") return splatProfileInto(phase, "laugh", scratch);
      if (name === "splat" || name === "burst") return splatProfileInto(phase, "idle", scratch);
      return profileFor(name);
    }

    var baseA = liveBody(fromDef.body, lobePhase, SCRATCH_SPLAT_A);
    var baseB = liveBody(toDef.body, lobePhase, SCRATCH_SPLAT_B);
    var mixSlot = 0;
    var base = mixProfilesInto(baseA, baseB, u, SCRATCH_MIX_A);

    var burstAmt = 0;
    if (state === "burst") {
      burstAmt = burstCollapse(local);
      base = mixProfilesInto(base, BURST_DOT, burstAmt, SCRATCH_MIX_B);
      mixSlot = 1;
    } else if (prevState === "burst" && u < 1) {
      burstAmt = burstCollapse(Math.max(0, local)) * (1 - u);
      base = mixProfilesInto(base, BURST_DOT, burstAmt, SCRATCH_MIX_B);
      mixSlot = 1;
    }

    if (expr.towardCircle > 0.001) {
      base = mixProfilesInto(base, CIRCLE, expr.towardCircle, mixSlot ? SCRATCH_MIX_A : SCRATCH_MIX_B);
    }

    var radiiScratch = applyViscousInto(base, t, seed, expr.pebble, SCRATCH_VISC);
    var radii = new Array(PROFILE_SAMPLES);
    for (var rcopy = 0; rcopy < PROFILE_SAMPLES; rcopy++) radii[rcopy] = radiiScratch[rcopy];

    var sleepAmt = 0;
    if (state === "sleep") sleepAmt = u;
    else if (prevState === "sleep") sleepAmt = 1 - u;

    var orbitAmt = 0;
    var orbitFade = 0;
    if (state === "orbit") {
      orbitAmt = u;
      var od = toDef.duration;
      orbitFade = local > od - 0.9 ? easeOutExp((local - (od - 0.9)) / 0.9) : 0;
    } else if (prevState === "orbit") {
      orbitAmt = 1 - u;
      orbitFade = u;
    }

    var liquid = expr.pebble;
    var breath = Math.sin((t / 2.85) * TAU + seed);
    var drip = Math.sin((t / 5.15) * TAU + seed * 1.8);
    var tilt = Math.sin((t / 4.4) * TAU + seed * 0.6);
    var breathK = 1 - 0.8 * sleepAmt;
    var sx = 1 + (0.006 + 0.012 * liquid) * breath * breathK + 0.006 * liquid * drip * breathK;
    var sy = 1 - (0.005 + 0.010 * liquid) * breath * breathK + 0.005 * liquid * tilt * breathK;
    /* Soft apex body life after land — quiet ~0.5% sx/sy pulse. */
    if (state === "laugh" && u > 0.85 && !reduced) {
      var apexLife = clamp01((u - 0.85) / 0.15);
      var apexA = Math.sin(t * 1.15 + seed * 0.7);
      var apexB = Math.sin(t * 0.88 + seed * 1.4);
      sx *= 1 + apexLife * 0.005 * apexA;
      sy *= 1 + apexLife * 0.0045 * apexB;
    }

    var faceRoll = expr.roll;
    if (state === "orbit" || prevState === "orbit") {
      var spinT = state === "orbit" ? local : local;
      faceRoll += spinT * 0.85 * orbitAmt * (1 - orbitFade);
    }
    /* Truth splat profiles are image-space; body does not get face tip rotation.
     * Catalogue shapes (egg/hex/…) still tip with roll. */
    var bodyIsSplat =
      fromDef.body === "splat" ||
      fromDef.body === "laugh" ||
      fromDef.body === "burst" ||
      toDef.body === "splat" ||
      toDef.body === "laugh" ||
      toDef.body === "burst";
    var bodyRoll = bodyIsSplat ? 0 : faceRoll;

    var pose = {
      rot: bodyRoll,
      cx: (0.002 + 0.012 * liquid) * Math.sin(t * 0.78 + seed * 2) * (1 - 0.7 * sleepAmt),
      cy: (0.0015 + 0.008 * liquid) * Math.cos(t * 0.56 + seed * 1.4) * (1 - 0.7 * sleepAmt),
      sx: sx,
      sy: sy
    };

    /* Soft perspective squash — tiny depth tip with orbit (flat-lit, no tumble). */
    if (!reduced && bodyIsSplat) {
      var depthTip = 0.5 + 0.5 * Math.sin(lobePhase * 2);
      var tipAmt = 0.035;
      if (state === "laugh") tipAmt = lerp(0.035, 0.015, u);
      else if (prevState === "laugh") tipAmt = lerp(0.015, 0.035, u);
      pose.sy *= 1 - tipAmt * depthTip;
    }

    if (sleepAmt > 0.001) {
      pose.cy += (0.11 + Math.sin(t * TAU / 0.6) * 0.19) * sleepAmt;
      var bounce = Math.sin(t * TAU / 0.6);
      pose.sy *= lerp(1, 1 - Math.max(0, -bounce) * 0.18, sleepAmt);
    }

    toPointsInto(radii, pose, 1, SCRATCH_PTS);
    var pts = new Array(PROFILE_SAMPLES);
    for (var pcopy = 0; pcopy < PROFILE_SAMPLES; pcopy++) {
      pts[pcopy] = { x: SCRATCH_PTS[pcopy].x, y: SCRATCH_PTS[pcopy].y };
    }

    var g0 = resolveGaze(fromDef, t, seed);
    var g1 = resolveGaze(toDef, t, seed);
    var gaze = { yaw: lerp(g0.yaw, g1.yaw, u), pitch: lerp(g0.pitch, g1.pitch, u) };
    /* Laugh: hard-mute wander (none at apex). Idle glance already near-still. */
    if (state === "laugh") {
      var gazeMute = 1 - u;
      gaze = { yaw: gaze.yaw * gazeMute, pitch: gaze.pitch * gazeMute };
    }
    var glance = gazeToGlance(gaze);

    var blink = blinkAmount(t, seed);
    if (toDef.blinkIn && local >= 0 && local < BLINK_DUR) {
      var forced = blinkEnvelope(local / BLINK_DUR);
      if (forced > blink) blink = forced;
    }

    var eyeScale = expr.eyeScale == null ? 1 : expr.eyeScale;
    var lx = -expr.eyeX + glance.x;
    var rx = expr.eyeX + glance.x;
    var ey = expr.eyeY + glance.y;
    var leftP = posePoint(placeOnBody(lx, ey, radii).x, placeOnBody(lx, ey, radii).y, pose);
    var rightP = posePoint(placeOnBody(rx, ey, radii).x, placeOnBody(rx, ey, radii).y, pose);

    var winkLeft = hash01(seed, 99) < 0.5;
    if (state === "wink" || prevState === "wink") {
      var aside = winkLeft ? 12 : -12;
      if (state === "wink") {
        gaze.yaw = lerp(g0.yaw, aside, u);
        glance = gazeToGlance(gaze);
        lx = -expr.eyeX + glance.x;
        rx = expr.eyeX + glance.x;
        leftP = posePoint(placeOnBody(lx, ey, radii).x, placeOnBody(lx, ey, radii).y, pose);
        rightP = posePoint(placeOnBody(rx, ey, radii).x, placeOnBody(rx, ey, radii).y, pose);
      }
    }

    var open = 1 - blink * 0.94;
    var eRx = expr.eyeRx * eyeScale;
    var eRy = expr.eyeRy * eyeScale;

    /* Face sticks to body via tip + (phase − land). At land ≈ tip (still match). */
    var faceRot = faceRoll || 0;
    if (state === "laugh") {
      faceRot = faceRoll + (lobePhase - landPhase);
    } else if (prevState === "laugh" && u < 1) {
      var leaveFaceFollow = 1 - easeOutExp(clamp01((t - changedAt) / Math.max(1e-6, morphDur)));
      faceRot = faceRoll + (lobePhase - landPhase) * leaveFaceFollow;
    }

    function buildEye(kind, pt, side) {
      if (kind === "squint") {
        var squintOpen = 0.32 * clamp01((u - 0.28) / 0.45);
        /* Squint flicker off — quiet gaze only. */
        return squintMark(pt.x, pt.y, side, eyeScale, squintOpen, faceRot);
      }
      if (kind === "dash" || kind === "wink") {
        return dashEye(pt.x, pt.y, 0.074 * eyeScale, faceRot);
      }
      return ovalEye(pt.x, pt.y, eRx * (1 + blink * 0.08), eRy * open, faceRot);
    }

    var leftKind = expr.eyeKind;
    var rightKind = expr.eyeKind;
    if (expr.eyeKind === "wink") {
      leftKind = winkLeft ? "dash" : "oval";
      rightKind = winkLeft ? "oval" : "dash";
    }

    var eyes = {
      kind: leftKind === rightKind ? leftKind : "mixed",
      left: buildEye(leftKind, leftP, -1),
      right: buildEye(rightKind, rightP, 1),
      fill: colorway.eye,
      stroke: colorway.eye,
      width: 0.048
    };

    var chew = 0.5 + 0.5 * Math.sin(t * 2.05 + seed * 1.4);
    var sigh = 0.5 + 0.5 * Math.sin(t * 0.68 + seed * 0.9);
    var live = (state === "thinking" || state === "sleep" || state === "burst") ? 0 : 1;
    live *= expr.eyeAlpha;
    var mouthOpen = 0;
    if (typeof world.mouthOpen === "number" && isFinite(world.mouthOpen)) {
      mouthOpen = clamp01(world.mouthOpen);
    } else if (state === "laugh") {
      mouthOpen = u;
    } else if (prevState === "laugh") {
      mouthOpen = 1 - u;
    }
    var liveOpen = live * mouthOpen;
    /* Open laugh chew/sigh ~0.7× pre-boost originals — gentle breathe, barely there. */
    var mw = expr.mouthW * lerp(MOUTH_CLOSED_W, 1, mouthOpen) * (1 + liveOpen * (0.038 * chew + 0.021 * sigh));
    var mh = Math.max(MOUTH_H_FLOOR, expr.mouthH * mouthOpen * (1 + liveOpen * (0.112 * chew + 0.056 * sigh)));
    var my = expr.mouthY + live * 0.01 * Math.sin(t * 1.35 + seed);
    var mouthAnchor = placeOnBody(glance.x * 0.35, my, radii);
    var mpt = posePoint(mouthAnchor.x, mouthAnchor.y, pose);
    var mouth;
    if (mouthOpen < 0.14) {
      /* Idle / closed: softer smile breathe (~half prior thick amp). */
      var chewN = chew * 2 - 1;
      var sighN = sigh * 2 - 1;
      var thickMul = 1 + live * (0.075 * chewN + 0.025 * sighN);
      var curveMul = 1 + live * (0.04 * sighN + 0.02 * chewN);
      var widthMul = 1 + live * (0.022 * chewN + 0.012 * sighN);
      var smileW = expr.mouthW * lerp(0.92, MOUTH_CLOSED_W, mouthOpen / 0.14) * widthMul;
      mouth = mouthSmile(
        mpt.x,
        mpt.y,
        smileW,
        SMILE_THICK * (1 - mouthOpen * 0.35) * thickMul,
        faceRot,
        SMILE_CURVE * curveMul
      );
    } else {
      mouth = mouthD(mpt.x, mpt.y, mw, mh, faceRot);
      if (mouthOpen < MOUTH_VOID_CUTOFF) {
        mouth.void.rx = 0;
        mouth.void.ry = 0;
      } else {
        mouth.void.rx *= (0.85 + liveOpen * 0.15 * chew) * mouthOpen;
        mouth.void.ry *= (0.85 + liveOpen * 0.20 * chew) * mouthOpen;
      }
    }

    var dots = [];
    var rings = [];
    var badge = null;

    var thinkAmt = 0;
    if (state === "thinking") thinkAmt = u;
    else if (prevState === "thinking") thinkAmt = 1 - u;
    if (thinkAmt > 0.02) {
      var pL = thinkPulse(t, 0);
      var pR = thinkPulse(t, DOT_STAGGER);
      dots.push({
        x: pose.cx - 0.48,
        y: pose.cy,
        r: 0.15 * (0.55 + 0.45 * pL),
        alpha: thinkAmt * (0.42 + 0.58 * pL),
        fill: colorway.body
      });
      dots.push({
        x: pose.cx + 0.48,
        y: pose.cy,
        r: 0.15 * (0.55 + 0.45 * pR),
        alpha: thinkAmt * (0.42 + 0.58 * pR),
        fill: colorway.body
      });
    }

    if ((state === "burst" || prevState === "burst") && (burstAmt > 0.02 || (state === "burst" && local < 1.6))) {
      var nPart = 7;
      var fly = easeOutExp(clamp01(local / 0.95));
      var fade = local < 0.55 ? 1 : 1 - clamp01((local - 0.55) / 0.9);
      if (prevState === "burst" && state !== "burst") fade *= 1 - u;
      if (fade > 0.02) {
        for (var pi = 0; pi < nPart; pi++) {
          var pang = (pi / nPart) * TAU + seed * 1.7;
          dots.push({
            x: Math.cos(pang) * fly * 0.92 + pose.cx,
            y: Math.sin(pang) * fly * 0.92 + pose.cy,
            r: 0.042 * (0.55 + 0.45 * fade),
            alpha: fade * 0.95,
            fill: colorway.body
          });
        }
      }
    }

    if (orbitAmt > 0.02) {
      var nRings = 3 + Math.floor(hash01(seed, 5) * 4);
      var rAlpha = orbitAmt * (1 - orbitFade) * 0.9;
      for (var ri = 0; ri < nRings; ri++) {
        var rr = 0.40 + ri * (0.58 / Math.max(1, nRings - 1));
        var spin = t * (0.62 + ri * 0.2) + ri * 1.25 + seed;
        var sweep = 1.5 + 0.42 * Math.sin(t * 0.72 + ri + seed);
        rings.push({
          r: rr,
          a0: spin + Math.PI * 0.12,
          a1: spin + Math.PI * 0.12 + sweep * 0.5,
          behind: true,
          alpha: rAlpha * 0.7,
          width: 0.016,
          cx: pose.cx,
          cy: pose.cy
        });
        rings.push({
          r: rr,
          a0: spin + Math.PI * 1.02,
          a1: spin + Math.PI * 1.02 + sweep * 0.42,
          behind: false,
          alpha: rAlpha * 0.95,
          width: 0.018,
          cx: pose.cx,
          cy: pose.cy
        });
      }
    }

    var notifyAmt = 0;
    if (state === "notify") notifyAmt = u;
    else if (prevState === "notify") notifyAmt = 1 - u;
    if (notifyAmt > 0.02) {
      var bang = -0.7;
      var edge = radiusAtAngle(radii, bang);
      var bLocal = { x: Math.cos(bang) * edge * 0.96, y: Math.sin(bang) * edge * 0.96 };
      var bpt = posePoint(bLocal.x, bLocal.y, pose);
      var pop = state === "notify" ? notifPop(local) : 1;
      badge = {
        x: bpt.x,
        y: bpt.y,
        r: 0.11 * pop * notifyAmt,
        fill: colorway.accent,
        alpha: notifyAmt
      };
    }

    var frame = {
      t: t,
      state: state,
      prevState: prevState,
      mix: u,
      radii: radii,
      pose: pose,
      points: pts,
      eyeAlpha: expr.eyeAlpha,
      blink: blink,
      gaze: gaze,
      dots: dots,
      rings: rings,
      badge: badge,
      face: {
        expression: expr.id,
        kind: eyes.kind,
        eyeAlpha: expr.eyeAlpha,
        rot: faceRot,
        eyes: eyes,
        mouth: {
          d: mouth.d,
          void: mouth.void,
          fill: colorway.accent,
          voidFill: colorway.void,
          cx: mpt.x,
          cy: mpt.y,
          w: mouth.w,
          h: mouth.h,
          rot: faceRot,
          open: mouthOpen,
          curve: mouth.curve == null ? SMILE_CURVE : mouth.curve,
          smile: !!mouth.smile
        }
      },
      colorway: colorway
    };
    Object.defineProperty(frame, "path", {
      enumerable: true,
      configurable: true,
      get: function () {
        if (!this._path) this._path = closedPath(this.points, BODY_TENSION);
        return this._path;
      }
    });
    return frame;
  }

  /* ------------------------------------------------------------------ */
  /*  SVG                                                               */
  /* ------------------------------------------------------------------ */

  var SVG_UID = 0;

  function scalePath(d, scale, ox, oy) {
    var out = "";
    var re = /([MLCQTSVHZAmlcqtsvha])([^MLCQTSVHZAmlcqtsvha]*)/g;
    var m;
    while ((m = re.exec(String(d)))) {
      var cmd = m[1];
      var raw = m[2].trim();
      if (cmd === "Z" || cmd === "z") {
        out += "Z";
        continue;
      }
      var nums = raw.split(/[\s,]+/).filter(Boolean).map(Number);
      if (cmd === "A" || cmd === "a") {
        out += "A";
        for (var i = 0; i < nums.length; i += 7) {
          out +=
            (i ? " " : "") +
            r4(nums[i] * scale) +
            " " +
            r4(nums[i + 1] * scale) +
            " " +
            nums[i + 2] +
            " " +
            nums[i + 3] +
            " " +
            nums[i + 4] +
            " " +
            r4(ox + nums[i + 5] * scale) +
            " " +
            r4(oy + nums[i + 6] * scale);
        }
        continue;
      }
      out += cmd;
      for (var j = 0; j < nums.length; j += 2) {
        out += (j ? " " : "") + r4(ox + nums[j] * scale) + " " + r4(oy + nums[j + 1] * scale);
      }
    }
    return out;
  }

  function arcPath(cx, cy, r, a0, a1) {
    var x0 = cx + r * Math.cos(a0);
    var y0 = cy + r * Math.sin(a0);
    var x1 = cx + r * Math.cos(a1);
    var y1 = cy + r * Math.sin(a1);
    var delta = ((a1 - a0) % TAU + TAU) % TAU;
    var large = delta > Math.PI ? 1 : 0;
    return (
      "M" +
      r4(x0) +
      " " +
      r4(y0) +
      "A" +
      r4(r) +
      " " +
      r4(r) +
      " 0 " +
      large +
      " 1 " +
      r4(x1) +
      " " +
      r4(y1)
    );
  }

  function eyeMarkup(eye, scale, ox, oy, color) {
    if (!eye) return "";
    if (eye.kind === "squint" || eye.kind === "dash") {
      var sw = (eye.width || 0.046) * scale;
      return (
        '<path d="' +
        scalePath(eye.d, scale, ox, oy) +
        '" fill="none" stroke="' +
        color +
        '" stroke-width="' +
        r4(sw) +
        '" stroke-linecap="round" stroke-linejoin="round"/>'
      );
    }
    var ecx = ox + eye.cx * scale;
    var ecy = oy + eye.cy * scale;
    var erot = eye.rot ? ' transform="rotate(' + r4((eye.rot * 180) / Math.PI) + " " + r4(ecx) + " " + r4(ecy) + ')"' : "";
    return (
      '<ellipse cx="' +
      r4(ecx) +
      '" cy="' +
      r4(ecy) +
      '" rx="' +
      r4(eye.rx * scale) +
      '" ry="' +
      r4(eye.ry * scale) +
      '"' +
      erot +
      ' fill="' +
      color +
      '"/>'
    );
  }

  function ringsMarkup(rings, behind, scale, ox, oy, accent) {
    if (!rings || !rings.length) return "";
    var s = "";
    for (var i = 0; i < rings.length; i++) {
      var rg = rings[i];
      if (!!rg.behind !== behind) continue;
      if (rg.alpha < 0.02) continue;
      var cx = ox + (rg.cx || 0) * scale;
      var cy = oy + (rg.cy || 0) * scale;
      s +=
        '<path d="' +
        arcPath(cx, cy, rg.r * scale, rg.a0, rg.a1) +
        '" fill="none" stroke="' +
        accent +
        '" stroke-width="' +
        r4((rg.width || 0.016) * scale) +
        '" stroke-linecap="round" opacity="' +
        r4(rg.alpha) +
        '"/>';
    }
    return s;
  }

  function dotsMarkup(dots, scale, ox, oy) {
    if (!dots || !dots.length) return "";
    var s = "";
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      if (d.alpha < 0.02 || d.r < 0.001) continue;
      s +=
        '<circle cx="' +
        r4(ox + d.x * scale) +
        '" cy="' +
        r4(oy + d.y * scale) +
        '" r="' +
        r4(d.r * scale) +
        '" fill="' +
        (d.fill || "#111") +
        '" fill-opacity="' +
        r4(d.alpha) +
        '"/>';
    }
    return s;
  }

  function toSVG(frame, opts) {
    opts = opts || {};
    var size = opts.size || 512;
    var paper = opts.paper === undefined ? "transparent" : opts.paper;
    var pad = opts.pad == null ? 0.34 : opts.pad;
    var flat = opts.flat !== false;
    var showShadow = opts.shadow == null ? false : !!opts.shadow;
    var uid = "as" + ++SVG_UID;

    var scale = size / (2 * (PEAK + pad));
    var ox = size / 2;
    var oy = size / 2 + size * 0.012;

    function xf(x, y) {
      return { x: ox + x * scale, y: oy + y * scale };
    }

    var pts = frame.points.map(function (p) {
      return xf(p.x, p.y);
    });
    var bodyD = closedPath(pts, BODY_TENSION);

    var c = frame.colorway;
    var shadowOp = c.dark ? 0.22 : 0.16;
    var shadowBlur = size * 0.042;
    var shadowDy = size * 0.028;

    var hi = xf(-0.22, -0.34);
    var sheenR = scale * 0.72;

    var filter = showShadow
      ? ("<filter id=\"" + uid + "sh\" x=\"-40%\" y=\"-40%\" width=\"180%\" height=\"180%\">" +
         "<feDropShadow dx=\"0\" dy=\"" + r4(shadowDy) + "\" stdDeviation=\"" + r4(shadowBlur) +
         "\" flood-color=\"#1a1914\" flood-opacity=\"" + shadowOp + "\"/></filter>")
      : "";

    var grad = flat ? "" : (
      "<radialGradient id=\"" + uid + "g\" cx=\"38%\" cy=\"32%\" r=\"68%\">" +
      "<stop offset=\"0%\" stop-color=\"" + c.highlight + "\"/>" +
      "<stop offset=\"42%\" stop-color=\"" + c.mid + "\"/>" +
      "<stop offset=\"100%\" stop-color=\"" + c.rim + "\"/></radialGradient>");

    var sheenGrad = flat ? "" : (
      "<radialGradient id=\"" + uid + "s\" cx=\"0\" cy=\"0\" r=\"1\" gradientUnits=\"userSpaceOnUse\" " +
      "fx=\"" + r4(hi.x) + "\" fy=\"" + r4(hi.y) + "\" " +
      "cx=\"" + r4(hi.x) + "\" cy=\"" + r4(hi.y) + "\" r=\"" + r4(sheenR) + "\">" +
      "<stop offset=\"0%\" stop-color=\"#ffffff\" stop-opacity=\"" + (c.dark ? 0.16 : 0.42) + "\"/>" +
      "<stop offset=\"55%\" stop-color=\"#ffffff\" stop-opacity=\"0.02\"/>" +
      "<stop offset=\"100%\" stop-color=\"#ffffff\" stop-opacity=\"0\"/></radialGradient>");

    var clip = flat ? "" : ("<clipPath id=\"" + uid + "c\"><path d=\"" + bodyD + "\"/></clipPath>");

    var paperRect =
      paper && paper !== "transparent"
        ? '<rect width="' + size + '" height="' + size + '" fill="' + paper + '"/>'
        : "";

    var backRings = ringsMarkup(frame.rings, true, scale, ox, oy, c.accent);

    var bodyFill = flat ? c.body : ("url(#" + uid + "g)");
    var bodyGroup =
      "<g" +
      (showShadow ? ' filter="url(#' + uid + 'sh)"' : "") +
      ">" +
      '<path d="' +
      bodyD +
      '" fill="' +
      bodyFill +
      '"/>' +
      "</g>";

    var inner = flat
      ? ""
      : (
      '<g clip-path="url(#' +
      uid +
      'c)">' +
      '<path d="' +
      bodyD +
      '" fill="url(#' +
      uid +
      's)"/>' +
      '<path d="' +
      bodyD +
      '" fill="none" stroke="' +
      c.edge +
      '" stroke-width="' +
      r4(size * 0.012) +
      '"/>' +
      "</g>");

    var extraDots = dotsMarkup(frame.dots, scale, ox, oy);

    var face = "";
    var eyeA = frame.eyeAlpha == null ? 1 : frame.eyeAlpha;
    if (frame.face && eyeA > 0.01) {
      var eyes = frame.face.eyes;
      var eyeBits =
        eyeMarkup(eyes.left, scale, ox, oy, eyes.fill || c.eye) +
        eyeMarkup(eyes.right, scale, ox, oy, eyes.fill || c.eye);
      var mouthDs = scalePath(frame.face.mouth.d, scale, ox, oy);
      var showVoid =
        frame.face.mouth.void &&
        frame.face.mouth.void.rx > 0.002 &&
        frame.face.mouth.void.ry > 0.002 &&
        (frame.face.mouth.open == null || frame.face.mouth.open >= MOUTH_VOID_CUTOFF);
      var voidMark = "";
      if (showVoid) {
        var voidPt = xf(frame.face.mouth.void.cx, frame.face.mouth.void.cy);
        var vrot = frame.face.mouth.void.rot || frame.face.mouth.rot || 0;
        var vrx = frame.face.mouth.void.rx * scale;
        var vry = frame.face.mouth.void.ry * scale;
        var vKind = frame.face.mouth.void.kind || "semi";
        var vrotAttr = vrot
          ? ' transform="rotate(' + r4((vrot * 180) / Math.PI) + " " + r4(voidPt.x) + " " + r4(voidPt.y) + ')"'
          : "";
        if (vKind === "semi") {
          voidMark =
            '<path d="' +
            semiVoidPath(voidPt.x, voidPt.y, vrx, vry) +
            '"' +
            vrotAttr +
            ' fill="' +
            frame.face.mouth.voidFill +
            '" fill-opacity="0.90"/>';
        } else {
          voidMark =
            '<ellipse cx="' +
            r4(voidPt.x) +
            '" cy="' +
            r4(voidPt.y) +
            '" rx="' +
            r4(vrx) +
            '" ry="' +
            r4(vry) +
            '"' +
            vrotAttr +
            ' fill="' +
            frame.face.mouth.voidFill +
            '" fill-opacity="0.90"/>';
        }
      }
      face =
        '<g opacity="' +
        r4(eyeA) +
        '">' +
        eyeBits +
        '<path d="' +
        mouthDs +
        '" fill="' +
        frame.face.mouth.fill +
        '"/>' +
        voidMark +
        "</g>";
    }

    var badge = "";
    if (frame.badge && frame.badge.r > 0.002) {
      var bp = xf(frame.badge.x, frame.badge.y);
      badge =
        '<circle cx="' +
        r4(bp.x) +
        '" cy="' +
        r4(bp.y) +
        '" r="' +
        r4(frame.badge.r * scale) +
        '" fill="' +
        frame.badge.fill +
        '" fill-opacity="' +
        r4(frame.badge.alpha == null ? 1 : frame.badge.alpha) +
        '"/>';
    }

    var frontRings = ringsMarkup(frame.rings, false, scale, ox, oy, c.accent);

    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      size +
      '" height="' +
      size +
      '" viewBox="0 0 ' +
      size +
      " " +
      size +
      '" fill="none">' +
      "<defs>" +
      filter +
      grad +
      sheenGrad +
      clip +
      "</defs>" +
      paperRect +
      backRings +
      bodyGroup +
      inner +
      extraDots +
      face +
      badge +
      frontRings +
      "</svg>"
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Canvas — same paint order as toSVG                                 */
  /* ------------------------------------------------------------------ */

  function rgba(hex, a) {
    var key = String(hex) + "|" + a;
    var hit = RGBA_CACHE[key];
    if (hit) return hit;
    var c = parseHex(hex);
    var s = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
    RGBA_CACHE[key] = s;
    return s;
  }

  function traceMouth(path, cx, cy, w, h, rot) {
    w = Math.max(0.001, w);
    h = Math.max(0.001, h);
    rot = rot || 0;
    var top = cy;
    var bot = cy + h;
    var midY = top + (bot - top) * 0.62;
    function P(x, y) {
      return rotAround(x, y, cx, cy, rot);
    }
    var p0 = P(cx - w, top);
    var p1 = P(cx + w, top);
    var c1 = P(cx + w, midY);
    var c2 = P(cx + w * 0.62, bot);
    var p2 = P(cx, bot);
    var c3 = P(cx - w * 0.62, bot);
    var c4 = P(cx - w, midY);
    path.moveTo(p0.x, p0.y);
    path.lineTo(p1.x, p1.y);
    path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
    path.bezierCurveTo(c3.x, c3.y, c4.x, c4.y, p0.x, p0.y);
    path.closePath();
  }

  function traceSmile(path, cx, cy, w, thick, rot, curve) {
    w = Math.max(0.001, w);
    thick = Math.max(0.028, thick == null ? SMILE_THICK : thick);
    rot = rot || 0;
    curve = curve == null ? SMILE_CURVE : curve;
    var dip = w * curve;
    var half = thick * 0.5;
    function P(x, y) {
      return rotAround(x, y, cx, cy, rot);
    }
    var midTopY = cy + dip - half;
    var midBotY = cy + dip + half;
    var cTopY = 2 * midTopY - cy;
    var cBotY = 2 * midBotY - cy;
    var pLi = P(cx - w, cy);
    var pRi = P(cx + w, cy);
    var pLo = P(cx - w, cy);
    var pRo = P(cx + w, cy);
    var cTop = P(cx, cTopY);
    var cBot = P(cx, cBotY);
    var cR_out = P(cx + w + half, cy + dip * 0.3);
    var cL_out = P(cx - w - half, cy + dip * 0.3);
    path.moveTo(pLi.x, pLi.y);
    path.quadraticCurveTo(cTop.x, cTop.y, pRi.x, pRi.y);
    path.quadraticCurveTo(cR_out.x, cR_out.y, pRo.x, pRo.y);
    path.quadraticCurveTo(cBot.x, cBot.y, pLo.x, pLo.y);
    path.quadraticCurveTo(cL_out.x, cL_out.y, pLi.x, pLi.y);
    path.closePath();
  }

  function traceClosed(ctx, pts, tension) {
    tension = tension == null ? TENSION : tension;
    var n = pts.length;
    if (n < 3) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n];
      var p1 = pts[i];
      var p2 = pts[(i + 1) % n];
      var p3 = pts[(i + 2) % n];
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) * tension,
        p1.y + (p2.y - p0.y) * tension,
        p2.x - (p3.x - p1.x) * tension,
        p2.y - (p3.y - p1.y) * tension,
        p2.x,
        p2.y
      );
    }
    ctx.closePath();
  }

  function tracePathD(ctx, d) {
    var re = /([MLCZAmlcza])([^MLCZAmlcza]*)/g;
    var m;
    while ((m = re.exec(String(d)))) {
      var cmd = m[1];
      var raw = m[2].trim();
      if (cmd === "Z" || cmd === "z") {
        ctx.closePath();
        continue;
      }
      var nums = raw.split(/[\s,]+/).filter(Boolean).map(Number);
      if (cmd === "M") {
        ctx.moveTo(nums[0], nums[1]);
        for (var i = 2; i < nums.length; i += 2) ctx.lineTo(nums[i], nums[i + 1]);
      } else if (cmd === "L") {
        for (var j = 0; j < nums.length; j += 2) ctx.lineTo(nums[j], nums[j + 1]);
      } else if (cmd === "C") {
        for (var k = 0; k < nums.length; k += 6) {
          ctx.bezierCurveTo(nums[k], nums[k + 1], nums[k + 2], nums[k + 3], nums[k + 4], nums[k + 5]);
        }
      }
    }
  }

  function fillEllipse(ctx, cx, cy, rx, ry, rot) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), rot || 0, 0, TAU);
    ctx.fill();
  }

  /** Top semicircle / half-ellipse: flat chord at bottom, curve toward eyes (tongue). */
  function fillSemiEllipse(ctx, cx, cy, rx, ry, rot) {
    rx = Math.max(0.01, rx);
    ry = Math.max(0.01, ry);
    ctx.beginPath();
    /* Canvas y-down: PI→TAU is left→up→right = top half. */
    ctx.ellipse(cx, cy, rx, ry, rot || 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  }

  /** SVG path for top semicircle (chord at cy, arc through cy−ry). */
  function semiVoidPath(cx, cy, rx, ry) {
    rx = Math.max(0.01, rx);
    ry = Math.max(0.01, ry);
    /* Chord left→right, sweep 0 (ccw) through top. */
    return (
      "M" + r4(cx - rx) + " " + r4(cy) +
      "L" + r4(cx + rx) + " " + r4(cy) +
      "A" + r4(rx) + " " + r4(ry) + " 0 0 0 " + r4(cx - rx) + " " + r4(cy) +
      "Z"
    );
  }

  function paintRings(ctx, rings, behind, scale, ox, oy, accent) {
    if (!rings || !rings.length) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = accent;
    for (var i = 0; i < rings.length; i++) {
      var rg = rings[i];
      if (!!rg.behind !== behind) continue;
      if (rg.alpha < 0.02) continue;
      ctx.globalAlpha = rg.alpha;
      ctx.lineWidth = (rg.width || 0.016) * scale;
      ctx.beginPath();
      ctx.arc(ox + (rg.cx || 0) * scale, oy + (rg.cy || 0) * scale, rg.r * scale, rg.a0, rg.a1);
      ctx.stroke();
    }
    ctx.restore();
  }

  function paintDots(ctx, dots, scale, ox, oy) {
    if (!dots || !dots.length) return;
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      if (d.alpha < 0.02 || d.r < 0.001) continue;
      ctx.globalAlpha = d.alpha;
      ctx.fillStyle = d.fill || "#111";
      fillEllipse(ctx, ox + d.x * scale, oy + d.y * scale, d.r * scale, d.r * scale);
    }
    ctx.globalAlpha = 1;
  }

  function paintEye(ctx, eye, scale, ox, oy, color) {
    if (!eye) return;
    if (eye.kind === "squint" || eye.kind === "dash") {
      ctx.strokeStyle = color;
      ctx.lineWidth = (eye.width || 0.046) * scale;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      tracePathD(ctx, scalePath(eye.d, scale, ox, oy));
      ctx.stroke();
      return;
    }
    ctx.fillStyle = color;
    fillEllipse(ctx, ox + eye.cx * scale, oy + eye.cy * scale, eye.rx * scale, eye.ry * scale, eye.rot || 0);
  }

  /**
   * Paint one sample() frame onto a 2D canvas. Same look as toSVG.
   * opts: { size=256, x=0, y=0, paper="transparent", flat=true, shadow=false, pad }
   * (x, y) is the top-left of the sprite box. Does not clear the canvas.
   */
  function drawCanvas(ctx, frame, opts) {
    if (!ctx || typeof ctx.save !== "function") {
      throw new Error("drawCanvas(ctx, frame, opts) needs a CanvasRenderingContext2D");
    }
    opts = opts || {};
    var size = opts.size == null ? 256 : opts.size;
    var x0 = opts.x || 0;
    var y0 = opts.y || 0;
    var paper = opts.paper === undefined ? "transparent" : opts.paper;
    var pad = opts.pad == null ? 0.34 : opts.pad;
    /* Grok Bot default: flat fill, no drop shadow. Pass flat:false / shadow:true for soft look. */
    var flat = opts.flat !== false;
    var showShadow = opts.shadow == null ? false : !!opts.shadow;

    var scale = size / (2 * (PEAK + pad));
    var ox = x0 + size / 2;
    var oy = y0 + size / 2 + size * 0.012;

    var src = frame.points || toPoints(frame.radii, frame.pose, 1);
    var pts = DRAW_PTS;
    var nsrc = src.length;
    for (var pi = 0; pi < nsrc; pi++) {
      var sp = src[pi];
      var dp = pts[pi] || (pts[pi] = { x: 0, y: 0 });
      dp.x = ox + sp.x * scale;
      dp.y = oy + sp.y * scale;
    }

    var c = frame.colorway;
    var minX = pts[0].x;
    var minY = pts[0].y;
    var maxX = pts[0].x;
    var maxY = pts[0].y;
    for (var bi = 1; bi < pts.length; bi++) {
      if (pts[bi].x < minX) minX = pts[bi].x;
      if (pts[bi].y < minY) minY = pts[bi].y;
      if (pts[bi].x > maxX) maxX = pts[bi].x;
      if (pts[bi].y > maxY) maxY = pts[bi].y;
    }
    var bw = Math.max(1e-6, maxX - minX);
    var bh = Math.max(1e-6, maxY - minY);

    ctx.save();

    if (paper && paper !== "transparent") {
      ctx.fillStyle = paper;
      ctx.fillRect(x0, y0, size, size);
    }

    paintRings(ctx, frame.rings, true, scale, ox, oy, c.accent);

    var hasPath2D = typeof Path2D === "function";
    var bodyPath = null;
    if (hasPath2D) {
      bodyPath = new Path2D();
      traceClosed(bodyPath, pts, BODY_TENSION);
    } else {
      ctx.beginPath();
      traceClosed(ctx, pts, BODY_TENSION);
    }

    if (showShadow) {
      var shadowOp = c.dark ? 0.18 : 0.13;
      var scx = (minX + maxX) * 0.5;
      var scy = maxY + size * 0.018;
      var srx = bw * 0.46;
      var sry = Math.max(size * 0.018, bh * 0.085);
      ctx.fillStyle = rgba("#1a1914", shadowOp * 0.55);
      fillEllipse(ctx, scx, scy + size * 0.008, srx * 1.08, sry * 1.35);
      ctx.fillStyle = rgba("#1a1914", shadowOp);
      fillEllipse(ctx, scx, scy, srx, sry);
      if (!hasPath2D) {
        ctx.beginPath();
        traceClosed(ctx, pts, BODY_TENSION);
      }
    }

    if (flat) {
      ctx.fillStyle = c.body;
      if (hasPath2D) ctx.fill(bodyPath);
      else ctx.fill();
    } else {
      var gcx = minX + bw * 0.38;
      var gcy = minY + bh * 0.32;
      var gr = 0.68 * Math.max(bw, bh);
      var bodyGrad = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, gr);
      bodyGrad.addColorStop(0, c.highlight);
      bodyGrad.addColorStop(0.42, c.mid);
      bodyGrad.addColorStop(1, c.rim);
      ctx.fillStyle = bodyGrad;
      if (hasPath2D) ctx.fill(bodyPath);
      else ctx.fill();

      ctx.save();
      if (hasPath2D) ctx.clip(bodyPath);
      else ctx.clip();

      var hiX = ox + -0.22 * scale;
      var hiY = oy + -0.34 * scale;
      var sheenR = scale * 0.72;
      var sheen = ctx.createRadialGradient(hiX, hiY, 0, hiX, hiY, sheenR);
      sheen.addColorStop(0, "rgba(255,255,255," + (c.dark ? 0.16 : 0.42) + ")");
      sheen.addColorStop(0.55, "rgba(255,255,255,0.02)");
      sheen.addColorStop(1, "rgba(255,255,255,0)");

      ctx.fillStyle = sheen;
      if (hasPath2D) ctx.fill(bodyPath);
      else ctx.fill();

      ctx.strokeStyle = c.edge;
      ctx.lineWidth = size * 0.012;
      if (hasPath2D) ctx.stroke(bodyPath);
      else ctx.stroke();
      ctx.restore();
    }

    paintDots(ctx, frame.dots, scale, ox, oy);

    var eyeA = frame.eyeAlpha == null ? 1 : frame.eyeAlpha;
    if (frame.face && eyeA > 0.01) {
      ctx.save();
      ctx.globalAlpha = eyeA;
      var eyes = frame.face.eyes;
      paintEye(ctx, eyes.left, scale, ox, oy, eyes.fill || c.eye);
      paintEye(ctx, eyes.right, scale, ox, oy, eyes.fill || c.eye);

      var mouth = frame.face.mouth;
      if (mouth.smile && mouth.w != null && mouth.h != null) {
        /* Thick short lime capsule: centerline stroke + round caps (= pill). */
        var mcx = ox + mouth.cx * scale;
        var mcy = oy + mouth.cy * scale;
        var mw = mouth.w * scale;
        var mh = Math.max(mouth.h * scale, scale * 0.06);
        var mrot = mouth.rot || 0;
        var dip = mw * (mouth.curve == null ? SMILE_CURVE : mouth.curve);
        ctx.save();
        ctx.translate(mcx, mcy);
        ctx.rotate(mrot);
        ctx.strokeStyle = mouth.fill;
        ctx.lineWidth = mh;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(-mw, 0);
        ctx.quadraticCurveTo(0, dip, mw, 0);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fillStyle = mouth.fill;
        ctx.beginPath();
        if (mouth.w != null && mouth.h != null) {
          traceMouth(ctx, ox + mouth.cx * scale, oy + mouth.cy * scale, mouth.w * scale, mouth.h * scale, mouth.rot || 0);
        } else {
          tracePathD(ctx, scalePath(mouth.d, scale, ox, oy));
        }
        ctx.fill();
      }

      if (
        mouth.void &&
        mouth.void.rx > 0.002 &&
        mouth.void.ry > 0.002 &&
        (mouth.open == null || mouth.open >= MOUTH_VOID_CUTOFF)
      ) {
        ctx.fillStyle = rgba(mouth.voidFill, 0.90);
        var vcx = ox + mouth.void.cx * scale;
        var vcy = oy + mouth.void.cy * scale;
        var vrx = mouth.void.rx * scale;
        var vry = mouth.void.ry * scale;
        var vrot = mouth.void.rot || mouth.rot || 0;
        if ((mouth.void.kind || "semi") === "semi") {
          fillSemiEllipse(ctx, vcx, vcy, vrx, vry, vrot);
        } else {
          fillEllipse(ctx, vcx, vcy, vrx, vry, vrot);
        }
      }
      ctx.restore();
    }

    if (frame.badge && frame.badge.r > 0.002) {
      ctx.save();
      ctx.globalAlpha = frame.badge.alpha == null ? 1 : frame.badge.alpha;
      ctx.fillStyle = frame.badge.fill;
      fillEllipse(ctx, ox + frame.badge.x * scale, oy + frame.badge.y * scale, frame.badge.r * scale, frame.badge.r * scale);
      ctx.restore();
    }

    paintRings(ctx, frame.rings, false, scale, ox, oy, c.accent);

    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /*  Engine handle (history is declared, never a wall clock)            */
  /* ------------------------------------------------------------------ */

  function createEngine(initial) {
    initial = initial || {};
    var colorway = initial.colorway || "encre";
    var state = resolveState(initial.state || "idle");
    var prevState = state;
    var changedAt = 0;
    var seed = initial.seed || 0;
    var morphDur = initial.morphDur || STATE_DEFS[state].morph || MORPH_DUR;
    var world = {
      colorway: colorway,
      state: state,
      prevState: prevState,
      changedAt: changedAt,
      seed: seed,
      morphDur: morphDur
    };

    return {
      setColorway: function (id) {
        colorway = id;
      },
      setState: function (next, atT) {
        next = resolveState(next);
        if (next === state) return;
        if (typeof atT !== "number" || !isFinite(atT)) {
          throw new Error("setState(state, t) needs the sample time of the change");
        }
        if (next === "laugh") {
          world.laughChangedAt = atT;
          world.laughMorphDur = STATE_DEFS.laugh.morph || LAUGH_MORPH_DUR;
        }
        prevState = state;
        state = next;
        changedAt = atT;
        morphDur = STATE_DEFS[state].morph || MORPH_DUR;
      },
      getState: function () {
        return {
          colorway: colorway,
          state: state,
          prevState: prevState,
          changedAt: changedAt,
          seed: seed,
          morphDur: morphDur
        };
      },
      sample: function (t) {
        world.colorway = colorway;
        world.state = state;
        world.prevState = prevState;
        world.changedAt = changedAt;
        world.seed = seed;
        world.morphDur = morphDur;
        return sample(t, world);
      }
    };
  }

  /**
   * Walk the official catalogue: idle → thinking → wink → wide → laugh →
   * notify → egg → hexagon → orbit → burst → sleep → idle …
   * Pure in t. `seed` phase-shifts the loop so agents desync.
   */
  function catalogueWorld(t, colorway, seed, out) {
    seed = seed || 0;
    var tOff = t + seed * 5.3;
    var u = ((tOff % SEQUENCE_DUR) + SEQUENCE_DUR) % SEQUENCE_DUR;
    var acc = 0;
    var dest = out || {};
    for (var i = 0; i < SEQUENCE.length; i++) {
      var id = SEQUENCE[i];
      var dur = STATE_DEFS[id].duration;
      if (u < acc + dur) {
        var prev = SEQUENCE[(i - 1 + SEQUENCE.length) % SEQUENCE.length];
        var local = u - acc;
        dest.colorway = colorway;
        dest.state = id;
        dest.prevState = prev;
        dest.changedAt = t - local;
        dest.seed = seed;
        dest.morphDur = STATE_DEFS[id].morph;
        return dest;
      }
      acc += dur;
    }
    dest.colorway = colorway;
    dest.state = "idle";
    dest.prevState = "sleep";
    dest.changedAt = t;
    dest.seed = seed;
    dest.morphDur = STATE_DEFS.idle.morph;
    return dest;
  }

  function heroWorld(t, colorway, seed) {
    return catalogueWorld(t, colorway, seed);
  }

  return {
    PROFILE_SAMPLES: PROFILE_SAMPLES,
    COLORWAYS: COLORWAYS,
    COLORWAY_BY_ID: COLORWAY_BY_ID,
    STATES: STATES,
    SEQUENCE: SEQUENCE,
    SEQUENCE_DUR: SEQUENCE_DUR,
    STATE_DEFS: STATE_DEFS,
    EXPRESSIONS: STATES,
    sample: sample,
    toSVG: toSVG,
    drawCanvas: drawCanvas,
    createEngine: createEngine,
    heroWorld: heroWorld,
    catalogueWorld: catalogueWorld,
    blinkAmount: blinkAmount,
    mouthOpenAmount: mouthOpenAmount,
    resolveColorway: resolveColorway,
    resolveState: resolveState,
    radiusAtAngle: radiusAtAngle,
    easeOutExp: easeOutExp,
    splatProfile: splatProfile,
    splatProfileInto: splatProfileInto,
    mouthSmile: mouthSmile,
    IDLE_ORBIT_PERIOD: IDLE_ORBIT_PERIOD,
    IDLE_ORBIT_SPEED: IDLE_ORBIT_SPEED,
    LAUGH_SPIN_TURNS: LAUGH_SPIN_TURNS,
    LAUGH_MORPH_DUR: LAUGH_MORPH_DUR,
    APEX_DRIFT_PERIOD: APEX_DRIFT_PERIOD,
    APEX_DRIFT_SPEED: APEX_DRIFT_SPEED,
    SPLAT_IDLE_TRUTH: SPLAT_IDLE_TRUTH,
    SPLAT_LAUGH_TRUTH: SPLAT_LAUGH_TRUTH,
    TRUTH_IDLE_TIP: TRUTH_IDLE_TIP,
    TRUTH_LAUGH_TIP: TRUTH_LAUGH_TIP,
    rotateRadii: rotateRadii,
    eggProfile: eggProfile,
    hexProfile: hexProfile,
    closedPath: closedPath,
    BODY_TENSION: BODY_TENSION,
    FACE_DISK: FACE_DISK,
    TENSION: TENSION,
    SMILE_THICK: SMILE_THICK,
    toPoints: toPoints
  };
});
