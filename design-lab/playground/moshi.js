/* MOSHI — the agent, portable.
 *
 * One file, zero deps, WebGL1. Drop a host element in any page (or any
 * WebView, in any app) and Moshi lives in it — from a 24px presence orb to a
 * full stage. This is the keeper from the design lab: the PS2-register
 * raymarched creature, with the two-channel doctrine intact:
 *
 *   FACE = the agent  (eyes, grin, ember — attention/blink/poke/REC-heat)
 *   BODY = the matter (lobes, waves, skin, veins — personality + drives)
 *
 * Body language is Blob Mixer's grammar, credited: 14islands' Blob Mixer
 * (https://blobmixer.14islands.com/, source via github.com/connorhvnsen/
 * blob-mixer) — two displacement layers (low-freq body waves + high-freq
 * surface skin) with pole/face protection, and NAMED PERSONALITIES à la its
 * Discobrain/T-1000/Slimebag presets. Limb migration, the flow bands, the
 * mouth tilt and the tongue are steals from the user's web-Claude symbiote
 * lab. Rendered our way: low-res nearest, Bayer dither, banded light,
 * faceted normals, animation on twos. Crunch is in-shader, so the look
 * ports wherever GLSL does.
 *
 * API — semantic drives, not sources. The host wires whatever it has
 * (engine meters, agent state, nothing) into the same scalars:
 *
 *   const m = Moshi(hostEl, { personality: 'TAR', seed: 0.5 });
 *   m.set('energy', v)        // 0..1  how hard the work is going
 *   m.set('mood', v)          // 0..1  resting grin + liveliness
 *   m.set('heat', v)          // 0..1  REC/excitement: ember, lime eyes
 *   m.setState('LISTENING')   // IDLE/LISTENING/RECORDING/PAUSED/RENDERING/SLEEPING
 *   m.celebrate()             // one-shot: a take landed
 *   m.setPersonality('GHOST' | 0.37 [, seed] [, {snap:true}])
 *   m.setQuality('ps2+'); m.reroll(); m.poke(); m.lookAt(nx, ny);
 *   m.state(); m.onPersonality(fn); m.destroy();
 *
 * The face is ON the body: drag him around and his face goes with him —
 * but he wants to face you, and eases home when you let go. His ATTENTION
 * is his own: he watches the viewer by default; the cursor must earn a
 * glance by passing near him, and sometimes he pointedly ignores it.
 */
(function () {
'use strict';

const FRAG = `
precision highp float;
uniform vec2  u_res;
uniform float u_time, u_tq;            // smooth + 12fps-quantized time
uniform float u_lph, u_bph, u_sph;     // INTEGRATED phases (rates lerp safely in JS)
uniform vec4  u_rotM;                  // body rotation: cosA, sinA, cos(.5+B), sin(.5+B)
uniform vec2  u_rotF;                  // face rotation:               cosB,    sinB
uniform float u_onset;                 // poke/slam envelope
uniform float u_energy, u_mood, u_heat;
uniform vec2  u_gaze, u_sq;            // gaze (face-space); spring squash (x,y)
uniform float u_blink, u_wide, u_lid;  // blink snap, startle, sleepy droop
uniform float u_sd, u_sd2;             // seed-derived texture offsets
uniform vec3  u_L1, u_L2, u_L3;        // lobe centers — CPU-computed per frame
uniform vec3  u_LR;                    // lobe radii   — (they're frame constants;
                                       //  recomputing them per map() per step per
                                       //  pixel was ~100M wasted trig ops/frame)
uniform float u_bw, u_bf;              // body waves: amplitude, spatial freq
uniform float u_sw, u_sf;              // surface skin: amplitude, spatial freq
uniform float u_smink;                 // lobe goo (smin k)
uniform vec3  u_palA, u_palB, u_palD;  // iq cosine palette (family material)
uniform float u_irid, u_glint, u_veins;
uniform float u_scale, u_room;
uniform float u_flow, u_flowPh;        // state channel: liquid bands (LIGHT only)
uniform float u_mtilt, u_inkeye;       // grin attitude; ink-faced families

const vec3 LIME = vec3(0.800, 1.000, 0.137);
const vec3 GLOW = vec3(0.851, 1.000, 0.298);

mat2 r2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float n3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i),               hash31(i + vec3(1,0,0)), u.x),
        mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), u.x), u.y),
    mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), u.x),
        mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), u.x), u.y), u.z);
}
float bayer(vec2 fc) {              // ordered dither — the texture of the render
  fc = floor(fc);                   // gl_FragCoord sits at pixel CENTERS (x.5):
                                    // un-floored, mod() returns {0.5,1.5} and the
                                    // matrix tops out at 1.31 — every floor(x+dth)
                                    // then fires at zero in a column lattice
  float b = mod(fc.x, 2.0) * 2.0 + mod(fc.y, 2.0);
  vec2 f2 = floor(fc / 2.0);
  float b2 = mod(f2.x, 2.0) * 2.0 + mod(f2.y, 2.0);
  return (b * 4.0 + b2) / 16.0;
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float chevron(vec2 p, float flip) {                  // +1 = '>'   -1 = '<'
  p.x *= flip;
  return min(sdSeg(p, vec2(-0.5, 0.62), vec2(0.5, 0.0)),
             sdSeg(p, vec2(-0.5, -0.62), vec2(0.5, 0.0)));
}
vec3 pal3(float t) {                 // the family material — iq cosine palette
  return clamp(u_palA + u_palB * cos(6.2831853 * (t + u_palD)), 0.0, 1.0);
}

float gRidge;
mat2 gA, gB;                         // world->body mat2s, built once in main()
float map(vec3 p) {
  vec3 pW = p;                                       // world frame
  p.xz = gA * p.xz;
  p.xy = gB * p.xy;
  p.x /= u_sq.x; p.y /= u_sq.y;                      // spring squash & stretch
  p /= u_scale; pW /= u_scale;
  // THE BODY — smin lobes; centers/radii arrive from the CPU (migration,
  // tuck and orbit drift are all baked into u_L*/u_LR each frame)
  float d = length(p) - 0.345;
  d = smin(d, length(p - u_L1) - u_LR.x, u_smink);
  d = smin(d, length(p - u_L2) - u_LR.y, u_smink);
  d = smin(d, length(p - u_L3) - u_LR.z, u_smink);
  // BLOB-MIXER GRAMMAR (14islands, credited): two displacement layers with
  // face protection (its poleAmount) — near-field only; far steps and miss
  // rays skip the 16 hash calls (max displacement ~0.25, gate at 0.45)
  if (d < 0.45) {
    float fz = 1.0 - 0.85 * smoothstep(0.40, 0.72, dot(normalize(pW), vec3(0.0, 0.0, 1.0)));
    d -= fz * u_bw * (1.0 + 0.55 * u_energy)
       * (n3(p * u_bf + vec3(0.0, u_bph, u_sd * 4.0)) - 0.5) * 2.0;
    float surf = n3(p * u_sf + vec3(u_sd2 * 7.0) + u_sph);
    gRidge = smoothstep(0.68, 0.95, surf);
    d -= fz * u_sw * (surf - 0.5) * 2.0;
  }
  d = max(d, length(p) - 0.80);                      // bound: one being
  return d * u_scale * min(u_sq.x, u_sq.y) * 0.9;    // squash-safe step
}
vec3 normalAt(vec3 p) {
  const vec2 e = vec2(0.004, -0.004);
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx)
                 + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

void main() {
  gA = mat2(u_rotM.x, -u_rotM.y, u_rotM.y, u_rotM.x);
  gB = mat2(u_rotM.z, -u_rotM.w, u_rotM.w, u_rotM.z);
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float dth = bayer(gl_FragCoord.xy);

  vec3 ro = vec3(0.0, 0.0, 3.3);
  vec3 rd = normalize(vec3(uv, -1.55));
  float t = 0.0; vec3 hp; bool hit = false;
  float dm = 1e9; vec3 bp = ro;
  for (int i = 0; i < 96; i++) {
    hp = ro + rd * t;
    float dl = map(hp);
    if (dl < dm) { dm = dl; bp = hp; }
    if (dl < 0.0025 + 0.0012 * t) { hit = true; break; }  // eps grows with t (LOD)
    t += dl * 0.85;                 // displaced field is not quite Lipschitz
    if (t > 5.0) break;
  }
  // step-starved grazing rays are SURFACE, not background — letting them fall
  // through paints the room's lime glow inside the body as a dither lattice
  if (!hit && dm < 0.05) { hit = true; hp = bp; }

  // THE ROOM (optional — stage mode): a dithered ground he sits on, a contact
  // glow he casts in his own material, a faint banded aura. Embeds skip it
  // (u_room = 0 -> transparent miss) so he composites anywhere.
  vec3 room = vec3(0.016, 0.016, 0.015);
  if (u_room > 0.5) {
    if (rd.y < -0.02) {                                  // the ground (y = -0.92)
      float tf = (-0.92 - ro.y) / rd.y;
      vec3 gp = ro + rd * tf;
      float gd = length(gp.xz);
      float fade = exp(-gd * 0.7) * exp(-max(0.0, tf - 4.0) * 0.4);
      float gr = n3(vec3(gp.x * 2.6, u_tq * 0.05, gp.z * 2.6));
      float gband = floor(gr * 3.0 + dth) / 3.0;
      room += vec3(0.030, 0.032, 0.028) * (0.6 + gband) * fade;
      room += mix(LIME, pal3(0.55), 0.45) * exp(-gd * 1.9) * fade
            * (0.040 + 0.10 * u_heat + 0.05 * u_energy);  // he lights his floor
    }
    float aur = exp(-dot(uv, uv) * 4.5) * (0.12 + 0.30 * u_energy + 0.55 * u_heat);
    room += pal3(0.62) * (floor(aur * 4.0 + dth) / 4.0) * 0.06;
  }
  vec4 outc = vec4(room, u_room);
  if (hit) {
    vec3 n0 = normalAt(hp);                          // smooth — rim/silhouette only
    vec3 n = normalize(floor(n0 * 2.5 + 0.5) / 2.5); // FACETS: calm low-poly planes
    vec3 nd = normalize(hp);
    // BLOB-MIXER LIGHTING, banded: colored key + fill + hard rim + clearcoat.
    vec3 KEY = normalize(vec3(0.5, 0.8, 0.6));
    vec3 FIL = normalize(vec3(-0.7, -0.25, 0.45));
    float bk = floor(max(dot(n, KEY), 0.0) * 3.0 + dth) / 3.0;   // 4 bands
    float bf = floor(max(dot(n, FIL), 0.0) * 2.0 + dth) / 2.0;   // cool fill
    float fres = pow(1.0 - max(dot(n0, -rd), 0.0), 3.0);
    // the gradient body: vertical drift + light + iridescent view shift
    float gt = 0.18 + 0.30 * (nd.y * 0.5 + 0.5) + 0.34 * bk + u_irid * 0.45 * fres;
    vec3 body = pal3(gt);
    // visible floor under the dither — band-promoted pixels must land ON a
    // body, never alone on black (alone they read as rain, not texture)
    vec3 col = body * (0.30 + 0.58 * bk) + body * 0.10 * bf;
    col *= 1.0 - 3.2 * u_sw * (1.0 - gRidge);                  // skin valleys shade
    col += pal3(gt + 0.12) * 4.5 * u_sw * step(0.75, gRidge) * bk;  // crests catch
    // clearcoat — one hard wet-plastic glint (their clearcoat, our band)
    vec3 H = normalize(KEY - rd);
    float spec = pow(max(dot(n, H), 0.0), 26.0);
    col += vec3(0.95) * step(0.60, spec + dth * 0.25) * 0.5 * u_glint;
    // rim: family-tinted, hard-edged (fres from the SMOOTH normal — faceted
    // fres fires on interior planes and rains dither over the whole body)
    col += mix(LIME, pal3(gt + 0.5), 0.6) * step(0.55, fres + dth * 0.07) * 0.15;
    // VEINS — always lime: the one brand constant on the body. Iso-curves of a
    // noise field in BODY space (noise keeps gradient nearly everywhere; flat
    // fold-fields dither into body-wide lattice rain). Shards = beads where a
    // second field peaks along a vein.
    vec3 bs = hp;
    bs.xz = gA * bs.xz;
    bs.xy = gB * bs.xy;
    bs /= u_scale;
    float f1 = n3(bs * 3.2 + vec3(u_sd * 9.0, u_lph * 0.15, u_sd2 * 5.0));
    float f2 = n3(bs * 5.0 + vec3(u_sd2 * 7.0, 0.0, u_lph * 0.10));
    float vein  = 1.0 - step(0.045 * (0.85 + 0.3 * dth), abs(f1 - 0.5));
    float shard = vein * step(0.62, f2);
    vein -= shard;
    col += LIME * vein  * u_veins * (0.15 + 0.40 * u_energy);
    col += GLOW * shard * u_veins * (0.30 + 0.70 * u_energy);
    // THE FLOW (state channel, LIGHT only — agent states may light the body,
    // never deform it): liquid bands circulating through him. The steal from
    // the user's web-Claude symbiote lab, quantized to the register.
    if (u_flow > 0.004) {
      float fb = 0.5 + 0.5 * sin(bs.y * 7.5 + n3(bs * 2.6 + vec3(u_sd * 3.0)) * 5.0 - u_flowPh);
      fb = pow(fb, 5.0);
      col += mix(LIME, pal3(gt + 0.35), 0.45)
           * (floor(fb * 2.0 + dth * 0.7) / 2.0) * 0.35 * u_flow;
    }
    // ── THE AGENT CHANNEL: the face — ON THE BODY. Drag him and the face goes
    // with him (bd = direction in the dynamic body frame); JS homes the body
    // back to face the room, and the eyes counter-rotate to hold your gaze.
    vec3 bd = nd;
    bd.xz = gA * bd.xz;
    bd.xy = mat2(u_rotF.x, -u_rotF.y, u_rotF.y, u_rotF.x) * bd.xy;
    float sq = 1.0 - 0.10 * u_onset;
    float lidv = max(u_blink, u_lid * 0.82);
    float eyeY = max(0.08, (1.0 + 0.35 * smoothstep(0.4, 1.0, u_heat))
                        * (1.0 - lidv * 0.92) * sq);
    vec3 eyeCol = mix(mix(vec3(0.90, 0.93, 0.87), vec3(0.05, 0.05, 0.06), u_inkeye),
                      LIME, smoothstep(0.45, 0.75, u_heat));
    eyeCol *= 0.60 + 0.45 * bk;                      // facet-lit like the hide
    for (int e = 0; e < 2; e++) {
      float s = (e == 0) ? -1.0 : 1.0;
      vec3 ed = normalize(vec3(s * 0.30 + u_gaze.x * 0.22, (0.20 + u_gaze.y * 0.16) * sq, 1.0));
      if (dot(bd, ed) < 0.6) continue;
      vec3 uu = normalize(cross(vec3(0.0, 1.0, 0.0), ed));
      vec3 vv = cross(ed, uu);
      vec2 o = vec2(dot(bd - ed, uu), dot(bd - ed, vv)) * 3.7;
      o.y /= eyeY;
      float ch = chevron(o * 1.6, -s);
      col = mix(col, eyeCol, 1.0 - step(0.20 + (dth - 0.5) * 0.10, ch));
    }
    {                                                // the grin dial — one scaler
      vec3 md = normalize(vec3(u_gaze.x * 0.26, (-0.30 + u_gaze.y * 0.15) * sq, 1.0));
      if (dot(bd, md) > 0.6) {
        vec3 mu = normalize(cross(vec3(0.0, 1.0, 0.0), md));
        vec3 mv = cross(md, mu);
        vec2 mo = vec2(dot(bd - md, mu), dot(bd - md, mv)) * 2.35;
        mo = r2(u_mtilt) * mo;                       // attitude: the family lean
        mo.y /= sq;
        float o2 = clamp(0.10 + 0.42 * u_mood + u_wide * 0.95 + u_onset * 0.18 + u_heat * 0.35, 0.0, 1.35);
        float r = 0.33 * (1.0 + 0.55 * o2);
        float lip = -0.07 + 0.30 * o2;
        float m = (1.0 - step(0.0, length(mo) - r + (dth - 0.5) * 0.05))
                * (1.0 - step(lip, mo.y));
        col = mix(col, LIME * (0.72 + 0.30 * u_heat), m);
        // the tongue — earns its place only when the grin is properly open
        float tng = (1.0 - step(0.0, length(mo - vec2(0.0, lip - r * 0.78)) - r * 0.46)) * m;
        col = mix(col, LIME * 0.32, tng * smoothstep(0.5, 0.8, o2));
      }
    }
    // the ember heart — heat only. Agent channel; the matter never splits.
    // tight core: a wide falloff band-dithers the whole front into speckle
    float ember = u_heat * exp(-4.2 * length(hp)) * (0.7 + 0.3 * sin(u_time * 7.0));
    col += GLOW * (floor(ember * 3.0 + dth * 0.5) / 3.0) * 0.55;
    outc = vec4(col, 1.0);
  }
  gl_FragColor = outc;
}`;

const VERT = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';

// ── PERSONALITIES — Blob Mixer's named-preset move, in our register.
// Each family = material (palette/irid/glint/veins) + displacement voice
// (bw/bf body waves · sw/sf surface skin · smin goo) + temperament.
const FAMILIES = {
  TAR:    { // the canonical Moshi — obsidian, lime-veined. where he started.
    bw: 0.030, bf: 1.8, bsp: 0.45, sw: 0.045, sf: 5.5, ssp: 0.35, k: 0.17,
    palA: [0.100, 0.100, 0.100], palB: [0.042, 0.046, 0.040], palD: [0.00, 0.00, 0.00],
    irid: 0.15, glint: 0.40, veins: 1.00, scale: 1.00, tilt: 0.07, ink: 0, restless: 0.50,
    blink: 1.0, sacc: 1.0, antic: 0.5, springK: 42, springD: 5.0, breathe: 0.012, spin: 0.05, tempo: 0.09 },
  DISCO:  { // their Discobrain — rainbow iridescence, fast shallow waves
    bw: 0.085, bf: 3.0, bsp: 1.45, sw: 0.016, sf: 7.0, ssp: 0.70, k: 0.20,
    palA: [0.50, 0.50, 0.50], palB: [0.42, 0.42, 0.42], palD: [0.00, 0.33, 0.67],
    irid: 0.90, glint: 0.80, veins: 0.45, scale: 0.98, tilt: 0.13, ink: 0, restless: 0.90,
    blink: 1.3, sacc: 1.5, antic: 0.9, springK: 60, springD: 4.2, breathe: 0.010, spin: 0.11, tempo: 0.14 },
  MOLTEN: { // their Molten — heavy gold skin, slow and certain
    bw: 0.034, bf: 2.1, bsp: 0.22, sw: 0.050, sf: 4.0, ssp: 0.18, k: 0.14,
    palA: [0.46, 0.30, 0.10], palB: [0.40, 0.27, 0.12], palD: [0.02, 0.10, 0.26],
    irid: 0.35, glint: 0.95, veins: 0.65, scale: 1.04, tilt: 0.04, ink: 0, restless: 0.20,
    blink: 0.7, sacc: 0.6, antic: 0.25, springK: 30, springD: 6.5, breathe: 0.016, spin: 0.03, tempo: 0.06 },
  GHOST:  { // their Ghost — airy violet drift, big soft waves
    bw: 0.125, bf: 1.6, bsp: 0.75, sw: 0.011, sf: 6.0, ssp: 0.45, k: 0.24,
    palA: [0.38, 0.40, 0.54], palB: [0.24, 0.28, 0.38], palD: [0.55, 0.62, 0.78],
    irid: 0.70, glint: 0.30, veins: 0.40, scale: 1.00, tilt: 0.06, ink: 0, restless: 0.35,
    blink: 0.8, sacc: 0.7, antic: 0.4, springK: 26, springD: 4.0, breathe: 0.020, spin: 0.07, tempo: 0.08 },
  SILK:   { // their Silkworm — long pearl swells, barely any skin
    bw: 0.080, bf: 1.3, bsp: 0.42, sw: 0.008, sf: 3.5, ssp: 0.25, k: 0.26,
    palA: [0.60, 0.54, 0.52], palB: [0.22, 0.22, 0.26], palD: [0.90, 0.97, 0.06],
    irid: 0.50, glint: 0.55, veins: 0.35, scale: 1.00, tilt: 0.02, ink: 0, restless: 0.25,
    blink: 0.85, sacc: 0.8, antic: 0.3, springK: 34, springD: 5.5, breathe: 0.015, spin: 0.04, tempo: 0.07 },
  BREAKS: { // ours — choppy hot amen-break energy, jagged and quick
    bw: 0.050, bf: 4.2, bsp: 1.85, sw: 0.038, sf: 8.5, ssp: 0.95, k: 0.13,
    palA: [0.45, 0.18, 0.10], palB: [0.40, 0.25, 0.15], palD: [0.00, 0.92, 0.85],
    irid: 0.25, glint: 0.50, veins: 1.00, scale: 0.97, tilt: 0.17, ink: 0, restless: 1.00,
    blink: 1.5, sacc: 1.8, antic: 1.0, springK: 75, springD: 3.6, breathe: 0.008, spin: 0.13, tempo: 0.16 },
  CHROME: { // their T-1000 — cold mirror, dense fine ripple
    bw: 0.055, bf: 2.6, bsp: 1.05, sw: 0.028, sf: 9.0, ssp: 0.80, k: 0.16,
    palA: [0.44, 0.49, 0.54], palB: [0.34, 0.34, 0.38], palD: [0.58, 0.60, 0.65],
    irid: 0.60, glint: 1.00, veins: 0.50, scale: 0.99, tilt: 0.05, ink: 0, restless: 0.45,
    blink: 0.9, sacc: 1.1, antic: 0.5, springK: 55, springD: 5.0, breathe: 0.010, spin: 0.08, tempo: 0.10 },
  BUBBLE: { // their Slimebag — goopy aqua-green bounce
    bw: 0.090, bf: 1.9, bsp: 0.65, sw: 0.020, sf: 4.5, ssp: 0.40, k: 0.25,
    palA: [0.30, 0.48, 0.24], palB: [0.26, 0.38, 0.22], palD: [0.25, 0.35, 0.45],
    irid: 0.45, glint: 0.70, veins: 0.55, scale: 1.02, tilt: 0.10, ink: 0, restless: 0.75,
    blink: 1.1, sacc: 1.2, antic: 0.8, springK: 38, springD: 3.2, breathe: 0.018, spin: 0.06, tempo: 0.11 },
  PORCELAIN: { // the paper look — bone body, ink eyes (their GHOST preset, inverted into our world)
    bw: 0.050, bf: 1.7, bsp: 0.50, sw: 0.016, sf: 5.0, ssp: 0.30, k: 0.22,
    palA: [0.74, 0.73, 0.70], palB: [0.16, 0.16, 0.15], palD: [0.02, 0.02, 0.02],
    irid: 0.12, glint: 0.55, veins: 0.50, scale: 1.00, tilt: 0.03, ink: 1, restless: 0.30,
    blink: 0.9, sacc: 0.8, antic: 0.35, springK: 40, springD: 5.5, breathe: 0.012, spin: 0.05, tempo: 0.08 },
};
const NAMES = Object.keys(FAMILIES);

// seeded hash (deterministic per (family, seed) — same inputs, same Moshi)
function mkHash(seed) {
  const s = Math.floor(seed * 9973) + 17;
  return k => { const x = Math.sin(s * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
}
// resolve a family + seed into the full numeric spec (the FIXED ENDPOINT
// that crossfades lerp between — never re-derive from a blended value)
function makeSpec(name, seed) {
  const F = FAMILIES[name], h = mkHash(seed);
  const j = (v, amt) => v * (1 + (h(j._k++) - 0.5) * 2 * amt);
  j._k = 1;
  return {
    name, seed,
    bw: j(F.bw, 0.15), bf: j(F.bf, 0.12), bsp: j(F.bsp, 0.15),
    sw: j(F.sw, 0.15), sf: j(F.sf, 0.12), ssp: j(F.ssp, 0.15),
    k: j(F.k, 0.10), scale: j(F.scale, 0.04),
    sd: h(11), sd2: h(12),
    palA: F.palA.slice(), palB: F.palB.slice(),
    palD: F.palD.map(d => d + (h(15) - 0.5) * 0.06),
    irid: F.irid, glint: F.glint, veins: F.veins,
    tilt: F.tilt, ink: F.ink, restless: F.restless,
    blink: F.blink, sacc: F.sacc, antic: F.antic,
    springK: F.springK, springD: F.springD, breathe: F.breathe,
    spin: F.spin, tempo: F.tempo,
  };
}
const NUMS = ['bw','bf','bsp','sw','sf','ssp','k','scale','sd','sd2',
  'irid','glint','veins','tilt','ink','restless',
  'blink','sacc','antic','springK','springD','breathe','spin','tempo'];
function lerpSpec(a, b, w) {
  const o = { name: w < 0.5 ? a.name : b.name, seed: w < 0.5 ? a.seed : b.seed };
  for (const k of NUMS) o[k] = a[k] + (b[k] - a[k]) * w;
  for (const k of ['palA','palB','palD'])
    o[k] = a[k].map((v, i) => v + (b[k][i] - v) * w);
  return o;
}
const UNIFS = ['u_res','u_time','u_tq','u_lph','u_bph','u_sph','u_rotM','u_rotF',
  'u_onset','u_energy','u_mood','u_heat','u_gaze','u_sq','u_blink','u_wide','u_lid',
  'u_sd','u_sd2','u_L1','u_L2','u_L3','u_LR','u_bw','u_bf','u_sw','u_sf','u_smink',
  'u_palA','u_palB','u_palD','u_irid','u_glint','u_veins','u_scale','u_room',
  'u_flow','u_flowPh','u_mtilt','u_inkeye'];

// ── THE CONSOLE DIAL — PS1 swims, PS2 holds. Resolution up, wobble down:
// vertex swim is the PS1 tell; the PS2 had subpixel-stable geometry.
const QUALITY = {
  'ps1':  { div: 4, maxW: 380, maxH: 240, wob: 1.00 },
  'ps2':  { div: 3, maxW: 512, maxH: 336, wob: 0.45 },
  'ps2+': { div: 2, maxW: 720, maxH: 450, wob: 0.15 },
};

// ── AGENT STATES — bundles of face behavior, tempo and light. Doctrine:
// states may LIGHT the body (flow, ember) but never deform it.
const STATES = {
  IDLE:      { mood: 0.55, heat: 0.0, flow: 0.00, frate: 0.0, tempo: 1.00, antics: 1.0,  lid: 0.00, blink: 1.00, gaze: 'wander' },
  LISTENING: { mood: 0.72, heat: 0.0, flow: 0.55, frate: 1.0, tempo: 0.90, antics: 0.0,  lid: 0.00, blink: 0.80, gaze: 'you', nod: true },
  RECORDING: { mood: 0.60, heat: 1.0, flow: 0.00, frate: 0.0, tempo: 1.00, antics: 0.0,  lid: 0.00, blink: 0.45, gaze: 'you' },
  PAUSED:    { mood: 0.38, heat: 0.0, flow: 0.00, frate: 0.0, tempo: 0.45, antics: 0.15, lid: 0.38, blink: 0.60, gaze: 'low' },
  RENDERING: { mood: 0.62, heat: 0.2, flow: 1.00, frate: 2.6, tempo: 0.70, antics: 0.0,  lid: 0.55, blink: 0.50, gaze: 'wander', shiver: true },
  SLEEPING:  { mood: 0.50, heat: 0.0, flow: 0.00, frate: 0.0, tempo: 0.30, antics: 0.0,  lid: 0.85, blink: 0.00, gaze: 'wander' },
};

const TAU = Math.PI * 2;
const clamp1 = v => Math.max(-1, Math.min(1, v));

function Moshi(host, opts = {}) {
  const O = Object.assign({
    personality: 'TAR', seed: 0.5, interactive: true, room: false,
    quality: 'ps2', resDiv: null, maxW: null, maxH: null, preserve: false,
  }, opts);

  const cv = document.createElement('canvas');
  cv.style.cssText = 'width:100%;height:100%;display:block;image-rendering:pixelated;image-rendering:crisp-edges;';
  host.appendChild(cv);

  let gl = null, prog = null, U = {}, dead = false;
  function initGL() {
    // opaque when he owns the frame (room mode) — cheaper composite; alpha
    // only for embeds. preserveDrawingBuffer defeats tile-discard on Apple
    // Silicon — off unless a harness asks (opts.preserve) to sample pixels.
    gl = cv.getContext('webgl', {
      antialias: false, alpha: !O.room, premultipliedAlpha: false,
      preserveDrawingBuffer: !!O.preserve,
    });
    if (!gl) throw new Error('moshi: webgl unavailable');
    const sh = (ty, src) => {
      const s = gl.createShader(ty);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const al = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(al);
    gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0);
    U = {};
    for (const n of UNIFS) U[n] = gl.getUniformLocation(prog, n);
    resize();
  }
  cv.addEventListener('webglcontextlost', e => e.preventDefault());
  cv.addEventListener('webglcontextrestored', () => { if (!dead) initGL(); });

  let cvRect = null;                  // cached — a getBoundingClientRect in the
  function rect() {                   // hot path forces layout mid-frame
    return cvRect || (cvRect = cv.getBoundingClientRect());
  }
  function resize() {
    cvRect = null;
    const Q = QUALITY[O.quality] || QUALITY['ps2'];
    const div = O.resDiv != null ? O.resDiv : Q.div;
    const r = host.getBoundingClientRect();
    const W = Math.max(24, Math.min(O.maxW != null ? O.maxW : Q.maxW, Math.floor(r.width / div))),
          H = Math.max(24, Math.min(O.maxH != null ? O.maxH : Q.maxH, Math.floor(r.height / div)));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl && gl.viewport(0, 0, W, H);
  }
  const rob = new ResizeObserver(resize);
  rob.observe(host);
  const onScroll = () => { cvRect = null; };
  addEventListener('scroll', onScroll, { passive: true, capture: true });

  // ── state ──
  let from = makeSpec(O.personality, O.seed),
      to = from, mix = 1, cur = from;          // personality crossfade
  const drives = { energy: 0.35, mood: 0.55, heat: 0.0 };
  const dCur = Object.assign({}, drives);
  let lph = 0, bph = 0, sph = 0;               // integrated phases (MORPH RULE)
  let rotA = 0, rotB = 0, rotTA = 0, rotTB = 0, spinV = 0;
  let wobA = 0, wobB = 0, tq = 0, lastTick = 0;
  let onsetEnv = 0, blink = 0, wide = 0, lid = 0, lidT = 0;
  let sy = 1, vy = 0;                          // squash spring
  let gaze = { x: 0, y: 0 }, gazeT = { x: 0, y: 0 }, lookHold = 0;
  let ptrAt = 0, ptrX = 0, ptrY = 0, prevPX = 0, prevPY = 0, idleT = 0;
  let petting = false, petCand = null, dragAt = null, dragged = false;
  let anticT = 4 + Math.random() * 8, stretchT = 0, shiverT = 0;
  let onChange = O.onPersonality || null;

  // ── ATTENTION — he watches YOU by default; the cursor must EARN a glance
  // (pass near him with speed), and sometimes he pointedly ignores it.
  let att = 'viewer', attT = 0, interest = 0, habit = 1, ignoreUntil = 0;
  let sacV = 0;                                // ballistic saccade burst (~90ms)
  let microT = 0.8;                            // micro-saccade jitter timer
  let headFT = 0, headFX = 0, headFY = 0;      // eyes lead, body follows ~150ms
  let lastBlinkAt = 0;
  function fireBlink() {
    const now = performance.now();
    if (now - lastBlinkAt < 600) return;       // punctuation, not stutter
    lastBlinkAt = now;
    blink = 1;
  }
  // a real saccade is ballistic: snap, land, HOLD. Drift reads dead.
  function saccadeTo(x, y, hold) {
    gazeT.x = clamp1(x); gazeT.y = clamp1(y);
    lookHold = hold;
    sacV = 1;
    const ecc = Math.hypot(gazeT.x - gaze.x, gazeT.y - gaze.y);
    if (ecc > 0.55) {
      if (Math.random() < 0.7) fireBlink();    // gaze-evoked blink
      headFT = 0.15; headFX = gazeT.x; headFY = gazeT.y;   // head follows later
    }
  }
  function retargetIdleGaze() {
    let tx, ty;
    if (st.gaze === 'you') { tx = (Math.random() - 0.5) * 0.22; ty = 0.08 + (Math.random() - 0.5) * 0.14; }
    else if (st.gaze === 'low') { tx = (Math.random() - 0.5) * 0.5; ty = -0.5 + (Math.random() - 0.5) * 0.2; }
    else {
      const r = Math.random();                 // center-biased wander: mostly you,
      if (r < 0.6)      { tx = (Math.random() - 0.5) * 0.3; ty = 0.06 + (Math.random() - 0.5) * 0.18; }
      else if (r < 0.9) { tx = (Math.random() - 0.5) * 0.9; ty = (Math.random() - 0.5) * 0.55; }
      else              { tx = (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 0.3); ty = (Math.random() - 0.5) * 0.7; }
    }
    // scan paths correlate; far darts hold SHORT, home fixations hold LONG
    const nx = gazeT.x * 0.25 + tx * 0.75, ny = gazeT.y * 0.25 + ty * 0.75;
    const ecc = Math.hypot(nx, ny);
    saccadeTo(nx, ny, (ecc > 0.6 ? 0.5 + Math.random() : 2 + Math.random() * 3) / Math.max(0.3, cur.sacc));
  }

  // agent state: behavior bundle + the flow light (phase integrated — MORPH RULE)
  let stName = 'IDLE', st = STATES.IDLE, autoSlept = false;
  let flowA = 0, flowPh = 0, celebT = 0, celebE = 0;
  function setStateRaw(n) {
    stName = n; st = STATES[n]; autoSlept = false;
    drives.mood = st.mood; drives.heat = st.heat;   // baselines; hosts may override
    if (n === 'LISTENING' || n === 'RECORDING') fireBlink();  // acknowledgment
  }

  // the migration steal: lobes that relocate — shift slides a lobe along its
  // orbit, transits tuck it in (it travels as a smaller thing)
  const lmb = [0, 1, 2].map(() => ({ s: 0, from: 0, tgt: 0, t0: 0, dur: 1, on: false }));
  let moveT = 6 + Math.random() * 8;
  function lobeMove(now) {
    const go = (i, tgt) => { const L = lmb[i]; L.from = L.s; L.tgt = tgt; L.t0 = now; L.dur = 1.3 + Math.random() * 1.5; L.on = true; };
    const r = Math.random();
    if (r < 0.45) go((Math.random() * 3) | 0, (Math.random() - 0.5) * 3.2);               // migrate
    else if (r < 0.72) { const a = lmb[0].s, b = lmb[1].s; go(0, b); go(1, a); }           // swap slots
    else [0, 1, 2].forEach(i => go(i, lmb[i].s + (Math.random() - 0.5) * 0.9));            // scatter
  }

  // ── idle life: blink on a life timer (events suppress it briefly) ──
  let blinkTimer = null;
  (function blinkLoop() {
    blinkTimer = setTimeout(() => {
      if (st.blink > 0) { fireBlink(); if (Math.random() < 0.18) setTimeout(() => { blink = 1; }, 240); }
      blinkLoop();
    }, (1700 + Math.random() * 4200) / Math.max(0.25, cur.blink * Math.max(0.05, st.blink)));
  })();

  // ── interaction: attention, poke, drag-spin, pet-and-hold ──
  function ptrDD() {                  // cursor distance from his center, in radii
    const R = rect();
    const m = Math.min(R.width, R.height) || 1;
    return Math.hypot(ptrX - (R.left + R.width / 2), ptrY - (R.top + R.height / 2)) / (0.5 * m);
  }
  function wake(startle) {
    if (stName === 'SLEEPING' && autoSlept) {
      const dd = ptrDD();
      if (startle && dd > 1.6) return;          // a far-off cursor doesn't bolt him awake
      setStateRaw('IDLE');
      if (startle) { wide = 0.7 * Math.max(0.3, 1.4 - dd * 0.7); fireBlink(); }
    }
    idleT = 0;
  }
  const onMove = e => {
    ptrX = e.clientX; ptrY = e.clientY; ptrAt = performance.now();
    wake(true);
    if (petCand) {
      const dx = e.clientX - petCand.x, dy = e.clientY - petCand.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) { petCand = null; }
    }
    if (dragAt) {
      const dx = e.clientX - dragAt[0], dy = e.clientY - dragAt[1];
      if (Math.abs(dx) + Math.abs(dy) > 5) { dragged = true; petCand = null; petting = false; }
      rotTA += dx * 0.006; rotTB += dy * 0.004;
      spinV = dx * 0.10;                              // inertia source
      dragAt = [e.clientX, e.clientY];
    }
  };
  const onDown = e => {
    wake(true); idleT = 0;
    dragAt = [e.clientX, e.clientY]; dragged = false;
    petCand = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onUp = () => {
    if (dragAt && !dragged && !petting) api.poke();
    dragAt = null; petting = false; petCand = null;
  };
  if (O.interactive) {
    addEventListener('pointermove', onMove);
    cv.addEventListener('pointerdown', onDown);
    addEventListener('pointerup', onUp);
    cv.style.cursor = 'grab';
  }

  // poke escalation bookkeeping
  let pokeN = 0, pokeAt = 0, annoyT = 0;

  // ── the loop ──
  let raf = 0, t0 = performance.now(), last = t0;
  function frame(now) {
    if (dead) return;
    const t = (now - t0) / 1000, dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // personality crossfade — fixed endpoints, eased
    if (mix < 1) {
      mix = Math.min(1, mix + dt / 1.1);
      const w = mix * mix * (3 - 2 * mix);
      cur = lerpSpec(from, to, w);
      if (mix >= 1) { from = to; cur = to; }
    }
    for (const k in drives) dCur[k] += (drives[k] - dCur[k]) * Math.min(1, dt * 6);

    // sleep: ignored long enough in IDLE, he drifts off. a NEAR touch wakes him.
    idleT += dt;
    if (O.interactive && stName === 'IDLE' && idleT > 45) { setStateRaw('SLEEPING'); autoSlept = true; }
    annoyT = Math.max(0, annoyT - dt);
    lidT = Math.max(st.lid, petting ? 0.65 : 0, annoyT > 0 ? 0.45 : 0);
    lid += (lidT - lid) * Math.min(1, dt * 3.5);
    const tScale = st.tempo * (petting ? 0.6 : 1.0);
    // the state's light: amount eases, phase integrates
    flowA += (st.flow - flowA) * Math.min(1, dt * 2.5);
    flowPh += dt * st.frate * tScale;
    celebT = Math.max(0, celebT - dt);
    celebE *= Math.pow(0.18, dt);
    if (st.shiver && Math.random() < dt * 0.5) shiverT = 0.35;

    // integrated phases — rates can lerp freely, motion never jumps
    lph += dt * cur.tempo * tScale * (1 + 0.8 * dCur.energy);
    bph += dt * cur.bsp * tScale * (0.6 + 1.4 * dCur.energy);
    sph += dt * cur.ssp * tScale;

    // squash spring (poke kicks vy; family stiffness/damping)
    const acc = -cur.springK * (sy - 1) - cur.springD * vy;
    vy += acc * dt; sy += vy * dt;
    sy = Math.max(0.72, Math.min(1.35, sy));
    let syF = sy + (stretchT > 0 ? 0.16 * Math.min(1, stretchT * 2) : 0);
    const breathe = 1 + cur.breathe * (1 + (stName === 'SLEEPING' || petting ? 1.2 : 0))
                  * Math.sin(t * (stName === 'SLEEPING' ? 1.1 : 1.9));
    const sx = 1 / Math.sqrt(syF);

    // ── ATTENTION ──
    lookHold -= dt;
    const live = O.interactive && (now - ptrAt < 150);
    let dd = 9;
    if (live) {
      dd = ptrDD();
      const spd = Math.hypot(ptrX - prevPX, ptrY - prevPY) / Math.max(dt, 1e-3);  // px/s
      // interest builds only when the cursor moves NEAR him; habit dulls it
      interest += dt * Math.min(3, spd * 0.0035) * Math.max(0, 1.3 - dd) * habit;
    }
    prevPX = ptrX; prevPY = ptrY;
    interest *= Math.pow(0.25, dt);
    // habituation: a cursor that camps next to him stops being news
    habit = Math.max(0.3, Math.min(1, habit + dt * (live && dd < 1.0 ? -0.12 : 0.2)));
    // proximity affection — habituated, two-way (no more frozen grin)
    if (!petting) {
      const prox = Math.max(0, 1 - Math.min(1, dd));
      const moodT = Math.min(1, st.mood + 0.35 * prox * habit);
      drives.mood += (moodT - drives.mood) * Math.min(1, dt * 1.2);
    }
    if (att === 'viewer') {
      if (interest > 0.5 && now > ignoreUntil && stName !== 'SLEEPING' && !dragAt) {
        interest = 0;
        if (Math.random() < 0.75) {            // glance at it…
          att = 'cursor'; attT = 0.5 + Math.random() * 1.0;
          fireBlink(); sacV = 1;
        } else {                               // …or pointedly not. (the snub
          ignoreUntil = now + 1500;            //  is what sells sentience)
          fireBlink();
        }
      }
      if (lookHold <= 0 && stName !== 'SLEEPING') retargetIdleGaze();
      // micro-saccades during holds — a perfectly still eye is a dead eye
      microT -= dt;
      if (microT <= 0) {
        microT = 0.6 + Math.random() * 0.9;
        gazeT.x = clamp1(gazeT.x + (Math.random() - 0.5) * 0.06);
        gazeT.y = clamp1(gazeT.y + (Math.random() - 0.5) * 0.06);
      }
    } else if (att === 'cursor') {
      const R = rect();
      const m = Math.min(R.width, R.height) || 1;
      gazeT.x = clamp1((ptrX - (R.left + R.width / 2)) / (0.6 * m));
      gazeT.y = clamp1(((R.top + R.height / 2) - ptrY) / (0.6 * m));
      attT -= dt;
      if (attT <= 0 || dd > 1.8) {             // seen it. back to YOU.
        att = 'viewer';
        saccadeTo(0, 0.06, 1.2 + Math.random() * 2);
        ignoreUntil = now + 2000 + Math.random() * 4000;
      }
    }
    // ballistic saccades: a ~90ms fast burst, then settle and HOLD
    sacV *= Math.pow(0.001, dt);
    const gs = Math.min(1, dt * (stName === 'SLEEPING' ? 1.2 : (att === 'cursor' ? 5.5 : 4.0 + 22 * sacV)) * cur.sacc);
    gaze.x += (gazeT.x - gaze.x) * gs;
    gaze.y += (gazeT.y - gaze.y) * gs;
    // eyes lead, the body follows a beat later
    if (headFT > 0) {
      headFT -= dt;
      if (headFT <= 0) { rotTA += headFX * 0.09; rotTB += -headFY * 0.035; }
    }

    // pet-and-hold: a long still press becomes a purr (and forgives pokes)
    if (petCand && !petting && now - petCand.t > 550) {
      petting = true; wide = 0; drives.mood = 1; annoyT = 0; pokeN = 0;
    }
    if (petting) { drives.mood = 1; rotTB += Math.sin(t * 9) * 0.0014; }

    // antics — family-biased: shiver, stretch, glance, spin-flair
    anticT -= dt;
    if (anticT <= 0 && st.antics > 0 && !petting) {
      anticT = (8 + Math.random() * 16 / Math.max(0.2, cur.antic)) / Math.max(0.05, st.antics);
      const r = Math.random();
      if (r < 0.3) shiverT = 0.5;
      else if (r < 0.55) stretchT = 1.1;
      else if (r < 0.8) saccadeTo((Math.random() < 0.5 ? -1 : 1) * 0.9, 0.5, 1.4);
      else { rotTA += (Math.random() - 0.5) * 2.2; fireBlink(); }
    }
    shiverT = Math.max(0, shiverT - dt);
    stretchT = Math.max(0, stretchT - dt);

    // lobe migration — IDLE-class business only; the body rearranges itself
    moveT -= dt;
    if (moveT <= 0 && st.antics > 0.2 && !petting) {
      lobeMove(t);
      moveT = (7 + Math.random() * 12) / Math.max(0.15, cur.restless);
    }
    const shiftV = [0, 0, 0], tuckV = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const L = lmb[i];
      if (L.on) {
        const ph = Math.min((t - L.t0) / L.dur, 1);
        const e = ph * ph * (3 - 2 * ph);
        L.s = L.from + (L.tgt - L.from) * e;
        tuckV[i] = Math.sin(ph * Math.PI);
        if (ph >= 1) { L.s = L.tgt; L.on = false; }
      }
      shiftV[i] = L.s;
    }

    // he WANTS to face you: drag/antics swing him away, he eases home
    // (the face is on the body now — homing is what keeps it findable)
    if (!dragAt) {
      const home = Math.round(rotTA / TAU) * TAU;
      const swayA = Math.sin(t * 0.4) * (0.05 + cur.spin * 0.6);
      const swayB = Math.sin(t * 0.27) * 0.04;
      rotTA += (home + swayA - rotTA) * Math.min(1, dt * 1.1);
      rotTB += (swayB - rotTB) * Math.min(1, dt * 1.1);
    }
    rotTA += spinV * dt;
    spinV *= Math.pow(0.12, dt);
    onsetEnv *= Math.pow(0.04, dt);
    blink *= Math.pow(0.0008, dt);
    wide *= Math.pow(0.15, dt);

    // rotation eases at FULL frame rate — easing it on the 12fps clock made
    // mouse drags render as dropped frames no matter how fast the GPU was.
    // The wobble and texture clock stay on twos: the crunch is a look, the
    // pose update rate is not.
    const rk = 1 - Math.pow(0.04, dt);
    rotA += (rotTA - rotA) * rk;
    rotB += (rotTB - rotB) * rk;
    if (t - lastTick > 1 / 12) {
      lastTick = t;
      const wAmp = ((0.005 + 0.010 * dCur.energy) * (stName === 'SLEEPING' ? 0.3 : 1)
                 + (shiverT > 0 ? 0.05 : 0)) * (QUALITY[O.quality] || QUALITY['ps2']).wob;
      wobA = (Math.random() - 0.5) * wAmp;
      wobB = (Math.random() - 0.5) * wAmp;
      tq = t;
    }

    // CPU-side frame constants (were recomputed per map() per step per pixel)
    const sd = cur.sd, sd2 = cur.sd2;
    const s1 = shiftV[0], s2 = shiftV[1], s3 = shiftV[2];
    const lA = rotA + wobA;
    const lB = rotB + wobB + (st.nod ? Math.sin(t * 2.1) * 0.02 : 0);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.u_res, cv.width, cv.height);
    gl.uniform1f(U.u_time, t);
    gl.uniform1f(U.u_tq, tq);
    gl.uniform1f(U.u_lph, lph);
    gl.uniform1f(U.u_bph, bph);
    gl.uniform1f(U.u_sph, sph);
    gl.uniform4f(U.u_rotM, Math.cos(lA), Math.sin(lA), Math.cos(0.5 + lB), Math.sin(0.5 + lB));
    gl.uniform2f(U.u_rotF, Math.cos(lB), Math.sin(lB));
    gl.uniform1f(U.u_onset, onsetEnv);
    gl.uniform1f(U.u_energy, Math.min(1, dCur.energy + celebE));
    gl.uniform1f(U.u_mood, dCur.mood);
    gl.uniform1f(U.u_heat, dCur.heat);
    // the eyes counter-rotate to hold YOUR gaze while the body is swung away
    {
      const wrapA = Math.atan2(Math.sin(rotA), Math.cos(rotA));
      gl.uniform2f(U.u_gaze, clamp1(gaze.x - wrapA * 0.55), clamp1(gaze.y + rotB * 0.45));
    }
    gl.uniform2f(U.u_sq, sx, syF);
    gl.uniform1f(U.u_blink, Math.min(1, blink));
    gl.uniform1f(U.u_wide, Math.min(1, wide));
    gl.uniform1f(U.u_lid, lid);
    gl.uniform1f(U.u_sd, sd);
    gl.uniform1f(U.u_sd2, sd2);
    gl.uniform3f(U.u_L1,
       0.25 * Math.sin(sd * 6.3 + lph + s1),  0.21 * Math.cos(sd2 * 7.1 + lph * 0.8 + s1 * 0.6),  0.14 * Math.sin(sd * 3.0 + lph));
    gl.uniform3f(U.u_L2,
      -0.24 * Math.cos(sd2 * 5.2 + lph + s2), -0.18 * Math.sin(sd * 8.4 + lph * 0.6 + s2 * 0.6), -0.15);
    gl.uniform3f(U.u_L3,
      -0.07 * Math.cos(sd * 2.2 + s3),        -0.23 * Math.sin(sd2 * 4.7 + lph * 0.7 + s3 * 0.6), -0.16 * Math.cos(sd * 2.2));
    gl.uniform3f(U.u_LR,
      (0.185 + 0.055 * sd2) * (1 - 0.22 * tuckV[0]),
      (0.165 + 0.050 * sd)  * (1 - 0.22 * tuckV[1]),
      (0.150 + 0.040 * sd2) * (1 - 0.22 * tuckV[2]));
    gl.uniform1f(U.u_bw, cur.bw);
    gl.uniform1f(U.u_bf, cur.bf);
    gl.uniform1f(U.u_sw, cur.sw);
    gl.uniform1f(U.u_sf, cur.sf);
    gl.uniform1f(U.u_smink, cur.k);
    gl.uniform3f(U.u_palA, cur.palA[0], cur.palA[1], cur.palA[2]);
    gl.uniform3f(U.u_palB, cur.palB[0], cur.palB[1], cur.palB[2]);
    gl.uniform3f(U.u_palD, cur.palD[0], cur.palD[1], cur.palD[2]);
    gl.uniform1f(U.u_irid, cur.irid);
    gl.uniform1f(U.u_glint, cur.glint);
    gl.uniform1f(U.u_veins, cur.veins);
    gl.uniform1f(U.u_scale, cur.scale * breathe);
    gl.uniform1f(U.u_room, O.room ? 1 : 0);
    gl.uniform1f(U.u_flow, flowA);
    gl.uniform1f(U.u_flowPh, flowPh);
    gl.uniform1f(U.u_mtilt, cur.tilt * (0.5 + 0.5 * dCur.mood) - (annoyT > 0 ? 0.22 : 0));
    gl.uniform1f(U.u_inkeye, cur.ink);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  }

  // ── API ──
  const api = {
    el: cv,
    set(k, v) { if (k in drives) drives[k] = Math.max(0, Math.min(1, +v)); return api; },
    setPersonality(nameOrSeed, seed, o) {
      let nm, sd;
      if (typeof nameOrSeed === 'number') {
        nm = NAMES[Math.floor((nameOrSeed % 1 + 1) % 1 * NAMES.length)]; sd = nameOrSeed;
      } else { nm = String(nameOrSeed).toUpperCase(); sd = seed != null ? seed : to.seed; }
      if (!FAMILIES[nm]) throw new Error('moshi: unknown personality ' + nm);
      if (o && o.snap) {                       // instant — initial states, tests
        from = to = cur = makeSpec(nm, sd); mix = 1;
      } else {
        from = cur === to ? to : lerpSpec(from, to, mix * mix * (3 - 2 * mix));
        to = makeSpec(nm, sd); mix = 0;
      }
      if (onChange) onChange(nm, sd);
      return api;
    },
    reroll() { return api.setPersonality(to.name, Math.random()); },
    setState(n) {
      n = String(n).toUpperCase();
      if (!STATES[n]) throw new Error('moshi: unknown state ' + n);
      setStateRaw(n);
      idleT = 0;
      return api;
    },
    celebrate() {                    // a take landed — one big joyful beat
      celebT = 1.5; celebE = 1;
      wide = 1; vy -= 5.2;
      rotTA += (Math.random() - 0.5) * 1.6;
      setTimeout(() => { if (!dead) { vy -= 3.0; fireBlink(); } }, 380);
      wake(false);
      return api;
    },
    setQuality(q) {
      if (!QUALITY[q]) throw new Error('moshi: unknown quality ' + q);
      O.quality = q;
      resize();
      return api;
    },
    // a poke is a CONVERSATION, not a button: five reactions, personality-
    // weighted, escalating to annoyance when you spam him. Petting forgives.
    poke() {
      const now = performance.now();
      pokeN = now - pokeAt < 4000 ? pokeN + 1 : 1;
      pokeAt = now;
      wake(false); idleT = 0;
      const R = rect();
      const m = Math.min(R.width, R.height) || 1;
      const px = clamp1((ptrX - (R.left + R.width / 2)) / (0.6 * m));
      const py = clamp1(((R.top + R.height / 2) - ptrY) / (0.6 * m));
      if (pokeN >= 5) {                          // DONE WITH YOU.
        annoyT = 4;
        drives.mood = 0.15;
        shiverT = 0.45;
        saccadeTo(px > 0 ? -0.8 : 0.8, -0.2, 2.5);     // pointedly away
        rotTA += px > 0 ? -0.5 : 0.5;
        ignoreUntil = now + 6000;
        return api;
      }
      if (pokeN >= 3) {                          // genuinely startled now
        wide = 1; vy -= 5.5; onsetEnv = Math.min(1.2, onsetEnv + 1.0);
        fireBlink(); setTimeout(() => { if (!dead) blink = 1; }, 220);
        rotTA += (Math.random() - 0.5) * 1.0;
        return api;
      }
      const r = Math.random() * (0.85 + 0.45 * cur.antic);  // temperament weights the menu
      if (r < 0.35) {                            // classic startle-hop
        onsetEnv = Math.min(1.2, onsetEnv + 0.8); wide = 1; vy -= 4.2;
        rotTA += (Math.random() - 0.5) * 0.7;
      } else if (r < 0.6) {                      // squash-oof: compress, double-blink
        vy += 4.5; onsetEnv = Math.min(1.2, onsetEnv + 0.6);
        fireBlink(); setTimeout(() => { if (!dead) blink = 1; }, 200);
      } else if (r < 0.85) {                     // double-take: the spot, then YOU
        vy -= 1.5;
        saccadeTo(px, py, 0.38);
        setTimeout(() => {
          if (dead) return;
          saccadeTo(0, 0.06, 1.5); wide = 0.6; fireBlink();
        }, 380);
      } else {                                   // delight-bounce: tongue out
        vy -= 3.5; wide = 0.9; celebE = Math.max(celebE, 0.5);
        drives.mood = 1;
        rotTA += (Math.random() - 0.5) * 1.2;
      }
      return api;
    },
    lookAt(nx, ny) { saccadeTo(nx, ny, 2); ignoreUntil = performance.now() + 2000; return api; },
    state() { return { personality: to.name, seed: to.seed, state: stName, quality: O.quality, petting, attention: att, drives: Object.assign({}, drives) }; },
    _move() { lobeMove((performance.now() - t0) / 1000); return api; },   // test hook
    onPersonality(fn) { onChange = fn; return api; },
    _step() {                       // one synchronous frame — for harnesses
      cancelAnimationFrame(raf);    // whose rAF is throttled (tests, captures)
      frame(performance.now());
      return api;
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf); clearTimeout(blinkTimer); rob.disconnect();
      removeEventListener('scroll', onScroll, { capture: true });
      if (O.interactive) {
        removeEventListener('pointermove', onMove);
        removeEventListener('pointerup', onUp);
      }
      const lc = gl && gl.getExtension('WEBGL_lose_context');
      if (lc) lc.loseContext();
      cv.remove();
    },
  };

  initGL();
  raf = requestAnimationFrame(frame);
  return api;
}

Moshi.PERSONALITIES = NAMES.slice();
Moshi.STATES = Object.keys(STATES);
Moshi.QUALITIES = Object.keys(QUALITY);
window.Moshi = Moshi;
})();
