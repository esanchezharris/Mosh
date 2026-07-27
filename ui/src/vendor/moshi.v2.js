/* MOSHI v2 — the symbiote grows teeth.
 *
 * One file, zero deps, WebGL1. Same portability doctrine as v1: drop a host
 * element in any page and Moshi lives in it. The two-channel doctrine is
 * intact and sharpened:
 *
 *   FACE = the agent  (chevron eyes + acid halo, lid-sweep blinks, the MAW —
 *                      a real interior with depth, glow, teeth and a weighted
 *                      tongue, skeptical raises, the ember heart)
 *   BODY = the matter (WET obsidian: layered specular — broad sheen, banded
 *                      gloss, tight clearcoat glints, fresnel rim — fake
 *                      subsurface transmission through the thin parts;
 *                      LIVING GOO: droplets that bud on the lower silhouette,
 *                      pinch off, fall and reabsorb into a ground skirt;
 *                      a TENDRIL CROWN: two multi-segment capsule chains that
 *                      sway with the drives and reach toward the cursor;
 *                      pumping veins carrying a luminance wave on the beat)
 *
 * Everything from v1 is preserved: the PS2 register (low-res buffer, Bayer
 * dither, banded light, faceted normals, 12fps texture clock), the 9
 * personalities (+2 new additive families: ABYSS, STATIC), 6 states, 7
 * poses, the attention/blink/saccade economy, poke escalation, pet-and-hold,
 * drag-spin, celebrate, and the SOD second-order pose engine.
 *
 * API — semantic drives, not sources. The host wires whatever it has into
 * the same scalars; v2 adds two additive drives (safe for old hosts):
 *
 *   const m = Moshi(hostEl, { personality: 'TAR', seed: 0.5 });
 *   m.set('energy', v)        // 0..1  how hard the work is going
 *   m.set('mood', v)          // 0..1  resting grin + liveliness
 *   m.set('heat', v)          // 0..1  REC/excitement: ember, lime eyes
 *   m.set('beat', v)          // 0..1  beat-clock pulse: veins carry the wave
 *   m.set('flux', v)          // 0..1  transient kick: surface shiver + flash
 *   m.setState('LISTENING')   // IDLE/LISTENING/RECORDING/PAUSED/RENDERING/SLEEPING
 *   m.celebrate()             // one-shot: a take landed (droplets burst + rain)
 *   m.setPersonality('GHOST' | 0.37 [, seed] [, {snap:true}])
 *   m.setQuality('ps3'); m.reroll(); m.poke(); m.lookAt(nx, ny);
 *   m.state(); m.onPersonality(fn); m.destroy();
 *
 * The face is ON the body: drag him around and his face goes with him —
 * but he wants to face you, and eases home when you let go. His ATTENTION
 * is his own: he watches the viewer by default; the cursor must earn a
 * glance, and when it does the crown tendrils reach for it.
 */
(function () {
'use strict';

const FRAG = `
precision highp float;
uniform vec3  u_ires;                  // 0.5*res (xy), 1/min(res) (z) — uploaded on resize
uniform float u_tq;                    // 12fps-quantized time
uniform vec4  u_pulse;                 // per-frame trig, hoisted off the GPU:
                                       // ember flicker, eye breath, grin breath
uniform vec2  u_mtiltCS;               // cos/sin of the grin attitude
uniform float u_lph, u_bph, u_sph;     // INTEGRATED phases (rates lerp safely in JS)
uniform vec4  u_rotM;                  // cos/sin yaw (xy), cos/sin pitch (zw)
uniform float u_onset;                 // poke/slam envelope
uniform float u_energy, u_mood, u_heat;
uniform float u_beat, u_beatPh, u_flux;// v2: beat-clock pulse (+integrated phase), transient kick
uniform float u_skept;                 // v2: skeptical asymmetric brow raise
uniform vec2  u_gaze, u_sq;            // gaze (face-space); spring squash (x,y)
uniform float u_blink, u_wide, u_lid;  // blink snap, startle, sleepy droop
uniform float u_sd, u_sd2;             // seed-derived texture offsets
uniform vec4  u_limbA[5];              // limb capsule START (xyz) + radius (w) —
uniform vec4  u_limbB[5];              // capsule END (xyz). CPU-bakes pose blend +
                                       // sway + endpoint trig (zero trig in map())
uniform vec4  u_tendA[6];              // v2 TENDRIL CROWN: 2 chains x 3 segments,
uniform vec4  u_tendB[6];              // CPU-baked sway + cursor reach
uniform vec4  u_drop[6];               // v2 LIVING GOO: droplet spheres (xyz + r)
uniform vec4  u_skirt;                 // v2 ground skirt (xyz + r) he reabsorbs into
uniform vec4  u_droolA, u_droolB;      // v2 SLEEPING drool string + tip bulge
uniform vec4  u_fx;                    // v2 state VFX: sonar, ember-transmission, streaks, drool
uniform float u_zflat;                 // 3D blob at rest -> 2D sticker on emotes
uniform vec2  u_lean;                  // the core leans into poses
uniform float u_coreS;                 // ...and breathes with them
uniform float u_faceE;                 // pose energy reaching the face
uniform float u_toon;                  // 0 = PS2 crunch, 1 = clean sticker (SOLID family)
uniform float u_mode;                  // render family: 0 SOLID (ps2/toon) · 1 BAKED
uniform float u_bw, u_bf;              // body waves: amplitude, spatial freq
uniform float u_sw, u_sf;              // surface skin: amplitude, spatial freq
uniform float u_smink;                 // lobe goo (smin k)
uniform vec3  u_palA, u_palB, u_palD;  // iq cosine palette (family material)
uniform float u_irid, u_glint, u_veins;
uniform float u_scale, u_room;
uniform float u_boundR;                // analytic bounding-sphere radius (world)
uniform float u_amb;                   // rest-luminance floor, in the family's own hue
uniform float u_bands;                 // key-light band count (per-family material)
uniform float u_facet;                 // crunch-normal facet density
uniform vec3  u_keyTint, u_filTint;    // per-family light tints (the material IS its light)
uniform float u_flow, u_flowPh;        // state channel: liquid bands (LIGHT only)
uniform float u_inkeye;                // ink-faced families

const vec3 LIME = vec3(0.800, 1.000, 0.137);
const vec3 GLOW = vec3(0.851, 1.000, 0.298);

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
float sdCap(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
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
mat2 gA, gB;                         // world->body: gA = yaw (xz), gB = pitch (yz)
float map(vec3 p) {
  vec3 pW = p;                                       // world frame
  p.xz = gA * p.xz;                                  // yaw — horizontal drag
  p.yz = gB * p.yz;                                  // pitch — vertical drag
  p.x /= u_sq.x; p.y /= u_sq.y;                      // spring squash & stretch
  p /= u_scale; pW /= u_scale;
  // THE SPLAT, in the round — a 3D blob at rest that snaps FLAT into the
  // sticker plane when he emotes. Limb configs arrive from the CPU with pose,
  // sway and tuck baked in; the core leans into poses and breathes with them.
  p.z *= u_zflat;
  vec3 lean = vec3(u_lean, 0.0);
  float d = length(p - lean * 0.5) - 0.30 * u_coreS;
  for (int i = 0; i < 5; i++)
    d = smin(d, sdCap(p, u_limbA[i].xyz, u_limbB[i].xyz, u_limbA[i].w), u_smink);
  // v2 TENDRIL CROWN — capsule chains off the crown; narrow smin so they read
  // as appendages, not lobes
  for (int i = 0; i < 6; i++) {
    if (u_tendA[i].w > 0.0005)
      d = smin(d, sdCap(p, u_tendA[i].xyz, u_tendB[i].xyz, u_tendA[i].w), 0.045);
  }
  // v2 GROUND SKIRT — the spread he reabsorbs into (squashed sphere, gooey k)
  {
    vec3 sqp = (p - u_skirt.xyz) * vec3(1.0, 3.0, 1.0);
    d = smin(d, length(sqp) - u_skirt.w, 0.13);
  }
  // v2 LIVING GOO — droplets budding / falling; small k so they stretch and
  // pinch like surface tension rather than popping
  for (int i = 0; i < 6; i++) {
    if (u_drop[i].w > 0.0005)
      d = smin(d, length(p - u_drop[i].xyz) - u_drop[i].w, 0.055);
  }
  // v2 DROOL — the sleeping string
  if (u_droolA.w > 0.0005) {
    d = smin(d, sdCap(p, u_droolA.xyz, u_droolB.xyz, u_droolA.w), 0.03);
    d = smin(d, length(p - u_droolB.xyz) - u_droolB.w, 0.03);   // the heavy tip
  }
  // BLOB-MIXER GRAMMAR (14islands, credited): two displacement layers with
  // face protection — near-field only; far steps and miss rays skip the hashes
  if (d < 0.45) {
    float fz = 1.0 - 0.85 * smoothstep(0.40, 0.72, dot(normalize(pW), vec3(0.0, 0.0, 1.0)));
    d -= fz * u_bw * (1.0 + 0.55 * u_energy)
       * (n3(p * u_bf + vec3(0.0, u_bph, u_sd * 4.0)) - 0.5) * 2.0;
    float surf = n3(p * u_sf + vec3(u_sd2 * 7.0) + u_sph);
    gRidge = smoothstep(0.68, 0.95, surf);
    d -= fz * u_sw * (surf - 0.5) * 2.0;
    // v2 FLUX — a transient kick shivers the skin
    if (u_flux > 0.01)
      d -= fz * u_flux * 0.045 * (n3(p * 6.5 + vec3(0.0, u_tq * 9.0, u_sd * 3.0)) - 0.5) * 2.0;
  }
  d = max(d, length(p) - 1.35);                      // bound: one being (+ crown)
  // squash safety / dynamic z-flatten Lipschitz correction
  return d * u_scale * min(u_sq.x, u_sq.y) * 0.9 / u_zflat;
}
vec3 normalAt(vec3 p) {
  const vec2 e = vec2(0.004, -0.004);
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx)
                 + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

void main() {
  gA = mat2(u_rotM.x, -u_rotM.y, u_rotM.y, u_rotM.x);
  gB = mat2(u_rotM.z, -u_rotM.w, u_rotM.w, u_rotM.z);
  vec2 uv = (gl_FragCoord.xy - u_ires.xy) * u_ires.z;
  // the STYLE dial starves the dither: toon is clean-edged like the stickers
  float dth = bayer(gl_FragCoord.xy) * (1.0 - 0.92 * u_toon);

  vec3 ro = vec3(0.0, 0.0, 3.3);
  vec3 rd = normalize(vec3(uv, -1.55));
  // analytic bounding sphere (u_boundR from the CPU): a ray that misses the
  // sphere never marches; a hit ray starts at sphere entry and bails at exit
  float t0m = 0.0, t1m = 5.5;
  {
    float bs = dot(ro, rd);
    float cs = dot(ro, ro) - u_boundR * u_boundR;
    float hs = bs * bs - cs;
    if (hs > 0.0) { float sh = sqrt(hs); t0m = max(0.0, -bs - sh); t1m = -bs + sh; }
    else t0m = 1e9;
  }
  float t = t0m; vec3 hp; bool hit = false;
  float dm = 1e9; vec3 bp = ro;
  if (t0m < 1e8) for (int i = 0; i < 96; i++) {
    hp = ro + rd * t;
    float dl = map(hp);
    if (dl < dm) { dm = dl; bp = hp; }
    if (dl < 0.0025 + 0.0012 * t) { hit = true; break; }  // eps grows with t (LOD)
    t += dl * 0.85;                 // displaced field is not quite Lipschitz
    if (t > t1m) break;
  }
  // step-starved grazing rays are SURFACE, not background
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
    vec3 n0 = normalAt(hp);                          // smooth — rim/silhouette/spec
    float smoothN = max(u_toon, u_mode);
    vec3 n = normalize(mix(normalize(floor(n0 * u_facet + 0.5) / u_facet), n0, smoothN));
    vec3 nd = normalize(hp);
    // BLOB-MIXER LIGHTING, banded: colored key + fill + hard rim + clearcoat.
    vec3 KEY = normalize(vec3(0.5, 0.8, 0.6));
    vec3 FIL = normalize(vec3(-0.7, -0.25, 0.45));
    vec3 H = normalize(KEY - rd);
    float nb = u_bands - u_toon;                     // family band count; toon drops one
    float bk = floor(min(max(dot(n, KEY), 0.0), 0.999) * nb + dth) / nb;
    float bf = floor(max(dot(n, FIL), 0.0) * 2.0 + dth) / 2.0 * (1.0 - u_toon);
    float fres = pow(1.0 - max(dot(n0, -rd), 0.0), 3.0);
    float glintE = u_glint * (1.0 + 1.4 * u_flux);   // the kick flashes the coat
    // the gradient body: vertical drift + light + iridescent view shift
    float gt = 0.18 + 0.30 * (nd.y * 0.5 + 0.5) + 0.34 * bk
             + u_irid * 0.45 * fres * (1.0 - 0.7 * u_toon);
    vec3 body = pal3(gt);
    vec3 shade = pal3(gt - 0.10);
    vec3 lit = pal3(gt + 0.035);
    vec3 col = shade * mix(0.30, 0.60, u_toon)
             + lit * (mix(0.58, 0.40, u_toon) * bk) * u_keyTint
             + shade * (0.10 * bf) * u_filTint;
    // rest floor: a whisper of the family's own hue so he never dies on black
    col += body * u_amb;
    col *= 1.0 - 3.2 * u_sw * (1.0 - gRidge) * (1.0 - u_toon);     // skin valleys
    col += pal3(gt + 0.12) * 4.5 * u_sw * step(0.75, gRidge) * bk * (1.0 - u_toon);

    // ── v2 WETNESS — the obsidian must read WET, never matte. Four layers:
    // broad smooth sheen, the classic banded gloss, tight clearcoat glints,
    // and a fresnel wet rim.
    float ndh0 = max(dot(n0, H), 0.0);
    float ndhF = max(dot(n, H), 0.0);
    // 1. broad sheen (smooth normal, soft lobe — the film of wet)
    col += u_keyTint * pow(ndh0, 6.0) * 0.10 * glintE * (0.55 + 0.45 * u_energy);
    // 2. banded gloss (the PS2 clearcoat band, on the facet normal)
    float spec = pow(ndhF, 26.0);
    col += vec3(0.95) * step(0.60, spec + dth * 0.25) * 0.42 * glintE * (1.0 - 0.6 * u_toon);
    // 3. tight clearcoat glints — tiny hot sparks that live INSIDE the gloss band
    float cc = pow(ndhF, 110.0);
    col += vec3(1.0) * step(0.72, cc + dth * 0.18) * 0.75 * glintE
         * smoothstep(0.25, 0.60, spec) * (1.0 - 0.4 * u_toon);
    // 4. wet fresnel rim — grazing angles catch the room, on the lit side only
    float wetR = pow(1.0 - max(dot(n0, -rd), 0.0), 5.0);
    col += mix(vec3(0.85), pal3(gt + 0.4), 0.45) * wetR * 0.10
         * (0.25 + 0.75 * bk) * (0.35 + 0.65 * glintE);

    // ── v2 TRANSMISSION — fake subsurface: family-hue glow through the thin
    // parts (limb tips, tendrils, droplets). One inward map tap measures
    // thinness; heat and energy push the glow.
    float back = map(hp - n0 * 0.12);
    float thin = clamp(1.0 + back / 0.12, 0.0, 1.0);
    float trAmt = thin * thin * (0.30 + 0.70 * clamp(dot(n0, -KEY) * 0.5 + 0.5, 0.0, 1.0));
    vec3 trCol = mix(pal3(gt + 0.30), LIME, 0.35);
    col += trCol * trAmt * (0.08 + 0.24 * u_heat + 0.12 * u_energy + 0.16 * u_flux)
         * (1.0 - 0.5 * u_toon);

    // edge fill — grazing facets shade near-black and read as a thick oil
    // border; a touch of body color in the silhouette band thins it
    col += body * 0.20 * smoothstep(0.5, 0.85, fres);
    // rim: family-tinted hard edge in PS2; a THIN dark outline ring in toon
    col += mix(LIME, pal3(gt + 0.5), 0.6) * step(0.55, fres + dth * 0.07) * 0.13
         * (0.35 + 0.65 * bk) * (1.0 - u_toon);
    col = mix(col, vec3(0.05, 0.055, 0.05),
              u_toon * (step(0.64, fres) - step(0.90, fres)));

    // body space for the surface effects below
    vec3 bs = hp;
    bs.xz = gA * bs.xz;
    bs.yz = gB * bs.yz;
    bs /= u_scale;

    // VEINS — always lime: the one brand constant on the body. v2: they PUMP —
    // a luminance wave radiates from the ember heart on the beat clock.
    float f1 = n3(bs * 3.2 + vec3(u_sd * 9.0, u_lph * 0.15, u_sd2 * 5.0));
    float f2 = n3(bs * 5.0 + vec3(u_sd2 * 7.0, 0.0, u_lph * 0.10));
    float vein  = 1.0 - step(0.045 * (0.85 + 0.3 * dth), abs(f1 - 0.5));
    float shard = vein * step(0.62, f2);
    vein -= shard;
    float beatW = 0.5 + 0.5 * sin(length(bs - vec3(0.0, -0.05, 0.10)) * 8.0 - u_beatPh * 3.0);
    float beatGlow = beatW * beatW * (0.20 + 0.80 * u_beat) * (0.35 + 0.65 * u_energy);
    col += LIME * vein  * u_veins * (0.12 + 0.28 * u_energy + beatGlow * 0.45);
    col += GLOW * shard * u_veins * (0.24 + 0.55 * u_energy + beatGlow * 0.75);

    // THE FLOW (state channel, LIGHT only): liquid bands circulating through him
    if (u_flow > 0.004) {
      float fb = 0.5 + 0.5 * sin(bs.y * 7.5 + n3(bs * 2.6 + vec3(u_sd * 3.0)) * 5.0 - u_flowPh);
      fb = pow(fb, 5.0);
      col += mix(LIME, pal3(gt + 0.35), 0.45)
           * (floor(fb * 2.0 + dth * 0.7) / 2.0) * 0.35 * u_flow;
    }
    // ── v2 STATE VFX (LIGHT only — states never deform the matter) ──
    // LISTENING: sonar ripple rings crossing the body
    if (u_fx.x > 0.004) {
      float rr = length(bs);
      float ph = fract(rr * 2.4 - u_flowPh * 0.9);
      float ring = pow(1.0 - abs(ph - 0.5) * 2.0, 7.0);
      col += LIME * (floor(ring * 2.0 + dth * 0.6) / 2.0) * 0.34 * u_fx.x;
    }
    // RECORDING: the ember heart shines THROUGH the matter + heat shimmer
    if (u_fx.y > 0.004) {
      float embTr = exp(-2.6 * length(hp - vec3(0.0, 0.0, 0.10)));
      col += GLOW * embTr * (thin * 0.95 + 0.05) * u_fx.y * u_heat
           * (0.55 + 0.45 * u_pulse.x);
      float shim = n3(vec3(gl_FragCoord.xy * 0.09, u_tq * 5.0));
      col += GLOW * (shim - 0.5) * 0.14 * u_fx.y * u_heat * exp(-3.0 * length(hp));
    }
    // RENDERING: directional work-current streaks streaming through him
    if (u_fx.z > 0.004) {
      float st2 = n3(bs * vec3(7.0, 1.5, 7.0) + vec3(u_sd * 3.0, -u_flowPh * 2.2, 0.0));
      float band = pow(st2, 5.0);
      col += mix(LIME, pal3(gt + 0.4), 0.5)
           * (floor(band * 2.0 + dth * 0.6) / 2.0) * 0.45 * u_fx.z;
    }
    // ── BAKED — the Humongous click-adventure look: soft baked lighting, no
    // dither/facets. Crossfaded with the solid col by the eased u_mode.
    if (u_mode > 0.001) {
      float wrap = dot(n0, KEY) * 0.5 + 0.5;                       // soft, no terminator
      float fill = max(dot(n0, FIL), 0.0);
      float ao = clamp(map(hp + n0 * 0.09) / 0.09, 0.0, 1.0);      // one tap -> crevice AO
      ao = mix(0.42, 1.0, ao);
      vec3 warm = vec3(1.07, 0.99, 0.85), cool = vec3(0.82, 0.88, 1.05);
      vec3 base = pal3(0.30 + 0.20 * (nd.y * 0.5 + 0.5));         // gentle vertical ramp
      vec3 bcol = base * ao * (0.52 + 0.55 * wrap) * warm;        // soft key
      bcol += base * 0.22 * fill * cool;                         // sky fill
      bcol += vec3(1.0) * pow(max(dot(n0, H), 0.0), 50.0) * 0.10 * u_glint;  // soft sheen
      bcol += pal3(0.6) * pow(fres, 2.0) * 0.12;                 // soft rim
      bcol += LIME * vein * 0.30 * u_veins;                      // soft veins, no crunch
      bcol += trCol * trAmt * 0.10;                              // v2: thin glow, soft
      col = mix(col, bcol, u_mode);
    }
    // ── THE AGENT CHANNEL: the face — ON THE BODY. Drag him and the face goes
    // with him; JS homes the body back and the eyes counter-rotate to hold you.
    vec3 bd = nd;
    bd.xz = gA * bd.xz;
    bd.yz = gB * bd.yz;
    float szLod = clamp(72.0 * u_ires.z, 1.0, 1.5);
    float sq = (1.0 - 0.10 * u_onset) * mix(1.0, u_sq.y, 0.6);
    float sqx = mix(1.0, u_sq.x, 0.6), sqy = mix(1.0, u_sq.y, 0.6);
    float lidv = max(u_blink, u_lid * 0.82);
    float eyeY = max(0.08, (1.0 + 0.05 * u_pulse.y                     // resting eye breath
                        + 0.35 * smoothstep(0.4, 1.0, u_heat) + 0.20 * u_faceE)
                        * (1.0 - lidv * 0.30) * sq);                   // v2: lids sweep,
                                                                       // barely squash now
    vec3 eyeCol = mix(mix(vec3(0.90, 0.93, 0.87), vec3(0.05, 0.05, 0.06), u_inkeye),
                      LIME, smoothstep(0.45, 0.75, u_heat));
    eyeCol *= (0.75 + 0.35 * bk) * (1.0 - 0.55 * lidv);
    for (int e = 0; e < 2; e++) {
      float s = (e == 0) ? -1.0 : 1.0;
      vec3 ed = normalize(vec3(s * 0.30 + u_gaze.x * 0.30 + u_lean.x * 0.8,
                               (0.20 + u_gaze.y * 0.22) * sq + u_lean.y * 0.8, 1.0));
      if (dot(bd, ed) < 0.55) continue;
      vec3 uu = normalize(cross(vec3(0.0, 1.0, 0.0), ed));
      vec3 vv = cross(ed, uu);
      vec2 o = vec2(dot(bd - ed, uu), dot(bd - ed, vv)) * (2.15 * szLod);
      o.x /= sqx;
      o.y /= sqy * eyeY;
      // v2 SKEPTICAL — the asymmetric raise: one brow rides up and half-lids,
      // the other eye widens a touch. Poke him enough and you'll see it.
      float sk = (e == 1) ? u_skept : -0.35 * u_skept;
      o.y -= sk * 0.26;
      float lidE = min(1.0, max(lidv, (e == 1) ? u_skept * 0.55 : 0.0));
      float ch = chevron(o * 1.6, -s);
      float em = 1.0 - step(0.24 + (dth - 0.5) * 0.10, ch);
      // v2 LID SWEEP — blinks are a top-down lid traveling over the glyph,
      // not a vertical squash
      float lidEdge = mix(1.45, -1.45, lidE * lidE);
      float lidM = step(o.y, lidEdge);
      em *= lidM;
      // the lid line itself — a soft skin-dark seam at the traveling edge
      float lidLine = (1.0 - step(0.05 + 0.35 * lidE, abs(o.y - lidEdge)))
                    * step(0.02, lidE) * step(lidEdge, 1.4);
      col = mix(col, shade * 0.55, lidLine * 0.7);
      // v2 ACID HALO — the glyph sits in a bloom of its own light
      float halo = exp(-max(ch - 0.20, 0.0) * 6.0);
      col += LIME * halo * (1.0 - em) * lidM
           * (0.16 + 0.35 * u_heat + 0.28 * u_energy + 0.50 * u_flux);
      col = mix(col, eyeCol, em);
      // the glint — a 1-2px spark high on the chevron
      float gli = 1.0 - step(0.07, length(o - vec2(u_gaze.x * 0.08 - s * 0.06,
                                                   0.16 + max(u_gaze.y, 0.0) * 0.05)));
      col = mix(col, vec3(0.95), gli * em * min(1.0, eyeY) * 0.9);
    }
    {                                                // the grin dial — one scaler
      vec3 md = normalize(vec3(u_gaze.x * 0.32 + u_lean.x * 0.8,
                               (-0.27 + u_gaze.y * 0.20) * sq + u_lean.y * 0.8, 1.0));
      if (dot(bd, md) > 0.55) {
        vec3 mu = normalize(cross(vec3(0.0, 1.0, 0.0), md));
        vec3 mv = cross(md, mu);
        vec2 mo = vec2(dot(bd - md, mu), dot(bd - md, mv)) * (1.55 * szLod);
        mo = mat2(u_mtiltCS.x, -u_mtiltCS.y, u_mtiltCS.y, u_mtiltCS.x) * mo;  // attitude: the family lean
        mo.y /= sq;
        float o2 = clamp(0.10 + 0.42 * u_mood + 0.05 * u_pulse.z             // resting grin breath
                       + u_wide * 0.95 + u_onset * 0.18 + u_heat * 0.35 + 0.18 * u_faceE
                       - 0.25 * u_blink, 0.0, 1.35);                            // blink purses the grin
        float r = 0.37 * (1.0 + 0.55 * o2);
        float lip = -0.07 + 0.30 * o2;
        float mdist = length(mo) - r + (dth - 0.5) * 0.05;
        float mIn = (1.0 - step(0.0, mdist)) * (1.0 - step(lip, mo.y));
        float openM = smoothstep(0.30, 0.55, o2);
        // closed: the classic acid grin, unchanged
        col = mix(col, LIME * (0.72 + 0.30 * u_heat), mIn * (1.0 - openM));
        // ── v2 THE MAW — open, it has an INTERIOR: dark cavity, acid glow at
        // the back of the throat, a lip seam, teeth when it's wide, and a
        // tongue with weight.
        float depth = clamp((lip - mo.y) / max(r * 1.1, 1e-3), 0.0, 1.0);
        vec3 maw = mix(vec3(0.012, 0.014, 0.010), vec3(0.004, 0.006, 0.004), depth);
        maw += LIME * pow(depth, 2.2) * (0.35 + 0.65 * u_heat + 0.35 * u_flux)
             * (0.85 + 0.15 * u_pulse.z);
        col = mix(col, maw, mIn * openM);
        // lip separation — a lit seam along the lip line
        float seam = (1.0 - step(0.028, abs(mo.y - lip))) * (1.0 - step(0.05, mdist));
        col = mix(col, LIME * (0.80 + 0.30 * u_heat), seam * openM * 0.85);
        // teeth — small upper row, only when the maw is truly wide
        float tw = smoothstep(0.75, 1.0, o2);
        if (tw > 0.01) {
          float lx = fract(mo.x * 5.0 + 0.5) - 0.5;
          float ty = (lip - mo.y) / 0.16;
          float tooth = step(abs(lx) * 2.2, 1.0 - ty) * step(0.0, ty) * step(ty, 1.0)
                      * step(abs(mo.x), r * 0.85) * mIn;
          col = mix(col, vec3(0.80, 0.85, 0.72), tooth * tw);
        }
        // the tongue — hangs with weight, wobbles a beat late, lit from above
        vec2 tp = mo - vec2(sin(u_tq * 2.3) * 0.03 * o2, lip - r * (0.52 + 0.18 * o2));
        tp.x *= 1.15;
        float tng = (1.0 - step(0.0, length(tp) - r * 0.52)) * mIn;
        float tShade = 0.55 + 0.45 * clamp(tp.y / max(r, 1e-3) + 0.8, 0.0, 1.0);
        col = mix(col, LIME * 0.30 * tShade + GLOW * 0.08 * tShade,
                  tng * openM * smoothstep(0.45, 0.70, o2));
      }
    }
    // the ember heart — heat only. Agent channel; the matter never splits.
    float ember = u_heat * exp(-4.2 * length(hp)) * (0.7 + 0.3 * u_pulse.x);
    col += GLOW * (floor(ember * 3.0 + dth * 0.5) / 3.0) * 0.55;
    col += LIME * (floor(ember * 6.0 + dth * 0.5) / 6.0) * step(0.55, u_heat) * 0.5;
    outc = vec4(col, 1.0);
  }
  gl_FragColor = outc;
}`;

const VERT = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';

// ── PERSONALITIES — Blob Mixer's named-preset move, in our register.
// Each family = material (palette/irid/glint/veins) + displacement voice
// (bw/bf body waves · sw/sf surface skin · smin goo) + temperament.
const FAMILIES = {
  TAR:    { // the canonical Moshi — wet obsidian, lime-veined. where he started.
    bw: 0.030, bf: 1.8, bsp: 0.45, sw: 0.045, sf: 5.5, ssp: 0.35, k: 0.17,
    palA: [0.100, 0.100, 0.100], palB: [0.042, 0.046, 0.040], palD: [0.00, 0.00, 0.00],
    irid: 0.15, glint: 0.62, veins: 1.00, scale: 1.00, tilt: 0.07, ink: 0, restless: 0.50,
    blink: 1.0, sacc: 1.0, antic: 0.5, springK: 42, springD: 5.0, breathe: 0.012, spin: 0.05, tempo: 0.09,
    amb: 0.11, bands: 3.0, facet: 2.5, keyT: [1.00, 1.00, 1.00], filT: [1.00, 1.00, 1.00] },
  DISCO:  { // their Discobrain — rainbow iridescence, fast shallow waves
    bw: 0.085, bf: 3.0, bsp: 1.45, sw: 0.016, sf: 7.0, ssp: 0.70, k: 0.20,
    palA: [0.50, 0.50, 0.50], palB: [0.42, 0.42, 0.42], palD: [0.00, 0.33, 0.67],
    irid: 0.90, glint: 0.80, veins: 0.45, scale: 0.98, tilt: 0.13, ink: 0, restless: 0.90,
    blink: 1.3, sacc: 1.5, antic: 0.9, springK: 60, springD: 4.2, breathe: 0.010, spin: 0.11, tempo: 0.14,
    amb: 0.05, bands: 3.0, facet: 2.5, keyT: [1.00, 1.00, 1.00], filT: [1.00, 1.00, 1.00] },
  MOLTEN: { // their Molten — heavy gold skin, slow and certain
    bw: 0.034, bf: 2.1, bsp: 0.22, sw: 0.050, sf: 4.0, ssp: 0.18, k: 0.14,
    palA: [0.46, 0.30, 0.10], palB: [0.40, 0.27, 0.12], palD: [0.02, 0.10, 0.26],
    irid: 0.35, glint: 0.95, veins: 0.65, scale: 1.04, tilt: 0.04, ink: 0, restless: 0.20,
    blink: 0.7, sacc: 0.6, antic: 0.25, springK: 30, springD: 6.5, breathe: 0.016, spin: 0.03, tempo: 0.06,
    amb: 0.06, bands: 3.0, facet: 2.5, keyT: [1.08, 0.95, 0.78], filT: [1.00, 1.00, 1.00] },
  GHOST:  { // their Ghost — airy violet drift, big soft waves
    bw: 0.125, bf: 1.6, bsp: 0.75, sw: 0.011, sf: 6.0, ssp: 0.45, k: 0.24,
    palA: [0.38, 0.40, 0.54], palB: [0.24, 0.28, 0.38], palD: [0.55, 0.62, 0.78],
    irid: 0.70, glint: 0.30, veins: 0.40, scale: 1.00, tilt: 0.06, ink: 0, restless: 0.35,
    blink: 0.8, sacc: 0.7, antic: 0.4, springK: 26, springD: 4.0, breathe: 0.020, spin: 0.07, tempo: 0.08,
    amb: 0.06, bands: 3.0, facet: 2.0, keyT: [1.00, 1.00, 1.00], filT: [0.90, 0.85, 1.15] },
  SILK:   { // their Silkworm — long pearl swells, barely any skin
    bw: 0.080, bf: 1.3, bsp: 0.42, sw: 0.008, sf: 3.5, ssp: 0.25, k: 0.26,
    palA: [0.60, 0.54, 0.52], palB: [0.22, 0.22, 0.26], palD: [0.90, 0.97, 0.06],
    irid: 0.50, glint: 0.55, veins: 0.35, scale: 1.00, tilt: 0.02, ink: 0, restless: 0.25,
    blink: 0.85, sacc: 0.8, antic: 0.3, springK: 34, springD: 5.5, breathe: 0.015, spin: 0.04, tempo: 0.07,
    amb: 0.025, bands: 3.0, facet: 2.0, keyT: [1.00, 1.00, 1.00], filT: [1.00, 1.00, 1.00] },
  BREAKS: { // ours — choppy hot amen-break energy, jagged and quick
    bw: 0.050, bf: 4.2, bsp: 1.85, sw: 0.038, sf: 8.5, ssp: 0.95, k: 0.13,
    palA: [0.45, 0.18, 0.10], palB: [0.40, 0.25, 0.15], palD: [0.00, 0.92, 0.85],
    irid: 0.25, glint: 0.50, veins: 1.00, scale: 0.97, tilt: 0.17, ink: 0, restless: 1.00,
    blink: 1.5, sacc: 1.8, antic: 1.0, springK: 75, springD: 3.6, breathe: 0.008, spin: 0.13, tempo: 0.16,
    amb: 0.07, bands: 3.0, facet: 3.0, keyT: [1.00, 1.00, 1.00], filT: [1.00, 1.00, 1.00] },
  CHROME: { // their T-1000 — cold mirror, dense fine ripple
    bw: 0.055, bf: 2.6, bsp: 1.05, sw: 0.028, sf: 9.0, ssp: 0.80, k: 0.16,
    palA: [0.44, 0.49, 0.54], palB: [0.34, 0.34, 0.38], palD: [0.58, 0.60, 0.65],
    irid: 0.60, glint: 1.00, veins: 0.50, scale: 0.99, tilt: 0.05, ink: 0, restless: 0.45,
    blink: 0.9, sacc: 1.1, antic: 0.5, springK: 55, springD: 5.0, breathe: 0.010, spin: 0.08, tempo: 0.10,
    amb: 0.05, bands: 4.0, facet: 4.0, keyT: [0.85, 0.92, 1.10], filT: [0.90, 0.97, 1.08] },
  BUBBLE: { // their Slimebag — goopy aqua-green bounce
    bw: 0.090, bf: 1.9, bsp: 0.65, sw: 0.020, sf: 4.5, ssp: 0.40, k: 0.25,
    palA: [0.30, 0.48, 0.24], palB: [0.26, 0.38, 0.22], palD: [0.25, 0.35, 0.45],
    irid: 0.45, glint: 0.70, veins: 0.55, scale: 1.02, tilt: 0.10, ink: 0, restless: 0.75,
    blink: 1.1, sacc: 1.2, antic: 0.8, springK: 38, springD: 3.2, breathe: 0.018, spin: 0.06, tempo: 0.11,
    amb: 0.05, bands: 3.0, facet: 2.5, keyT: [1.00, 1.00, 1.00], filT: [1.00, 1.00, 1.00] },
  PORCELAIN: { // the paper look — bone body, ink eyes (their GHOST preset, inverted into our world)
    bw: 0.050, bf: 1.7, bsp: 0.50, sw: 0.016, sf: 5.0, ssp: 0.30, k: 0.22,
    palA: [0.74, 0.73, 0.70], palB: [0.16, 0.16, 0.15], palD: [0.02, 0.02, 0.02],
    irid: 0.12, glint: 0.55, veins: 0.50, scale: 1.00, tilt: 0.03, ink: 1, restless: 0.30,
    blink: 0.9, sacc: 0.8, antic: 0.35, springK: 40, springD: 5.5, breathe: 0.012, spin: 0.05, tempo: 0.08,
    amb: 0.02, bands: 2.0, facet: 2.5, keyT: [1.00, 1.00, 1.00], filT: [1.00, 1.00, 1.00] },
  ABYSS:  { // v2 ADD — deep-water pressure: blue-black flesh, cold bioluminescence
    bw: 0.055, bf: 1.5, bsp: 0.30, sw: 0.020, sf: 4.0, ssp: 0.22, k: 0.22,
    palA: [0.05, 0.09, 0.14], palB: [0.06, 0.20, 0.26], palD: [0.55, 0.60, 0.65],
    irid: 0.55, glint: 0.85, veins: 0.90, scale: 1.02, tilt: 0.05, ink: 0, restless: 0.30,
    blink: 0.6, sacc: 0.5, antic: 0.3, springK: 24, springD: 5.0, breathe: 0.018, spin: 0.04, tempo: 0.05,
    amb: 0.05, bands: 3.0, facet: 2.5, keyT: [0.80, 0.95, 1.15], filT: [0.75, 0.90, 1.20] },
  STATIC: { // v2 ADD — dead-channel jitter: monochrome flesh under signal noise
    bw: 0.040, bf: 5.0, bsp: 2.20, sw: 0.055, sf: 12.0, ssp: 1.60, k: 0.12,
    palA: [0.30, 0.31, 0.33], palB: [0.26, 0.26, 0.28], palD: [0.00, 0.00, 0.00],
    irid: 0.10, glint: 0.65, veins: 0.70, scale: 0.98, tilt: 0.12, ink: 0, restless: 1.00,
    blink: 1.8, sacc: 2.0, antic: 1.0, springK: 85, springD: 3.2, breathe: 0.007, spin: 0.15, tempo: 0.20,
    amb: 0.05, bands: 3.0, facet: 5.0, keyT: [1.00, 1.00, 1.00], filT: [1.00, 1.00, 1.00] },
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
    // THE SPLAT's anatomy: five limbs (left arm, head, right arm, right leg,
    // left leg), seeded inside the brand silhouette's lines
    limbA: BASE_ANG.map((a, i) => a + (h(21 + i) - 0.5) * 0.3),
    limbL: BASE_ANG.map((a, i) => 0.50 * (1 + (h(31 + i) - 0.5) * 0.24)),
    limbR: BASE_ANG.map((a, i) => 0.155 * (1 + (h(41 + i) - 0.5) * 0.30)),
    // fore/aft tilts (alternating, seeded): the limbs live in 3D space at rest
    limbT: [0.22, -0.22, 0.22, -0.22, 0.22].map((b, i) => b + (h(51 + i) - 0.5) * 0.36),
    palA: F.palA.slice(), palB: F.palB.slice(),
    palD: F.palD.map(d => d + (h(15) - 0.5) * 0.06),
    irid: F.irid, glint: F.glint, veins: F.veins,
    tilt: F.tilt, ink: F.ink, restless: F.restless,
    blink: F.blink, sacc: F.sacc, antic: F.antic,
    springK: F.springK, springD: F.springD, breathe: F.breathe,
    spin: F.spin, tempo: F.tempo,
    // beauty fields — MORPH RULE: they crossfade like every other endpoint
    amb: F.amb, bands: F.bands, facet: F.facet,
    keyT: F.keyT.slice(), filT: F.filT.slice(),
  };
}
const NUMS = ['bw','bf','bsp','sw','sf','ssp','k','scale','sd','sd2',
  'irid','glint','veins','tilt','ink','restless',
  'blink','sacc','antic','springK','springD','breathe','spin','tempo',
  'amb','bands','facet'];
function lerpSpec(a, b, w) {
  const o = { name: w < 0.5 ? a.name : b.name, seed: w < 0.5 ? a.seed : b.seed };
  for (const k of NUMS) o[k] = a[k] + (b[k] - a[k]) * w;
  for (const k of ['palA','palB','palD','limbA','limbL','limbR','limbT','keyT','filT'])
    o[k] = a[k].map((v, i) => v + (b[k][i] - v) * w);
  return o;
}
const UNIFS = ['u_ires','u_tq','u_pulse','u_mtiltCS','u_lph','u_bph','u_sph','u_rotM',
  'u_onset','u_energy','u_mood','u_heat','u_beat','u_beatPh','u_flux','u_skept',
  'u_gaze','u_sq','u_blink','u_wide','u_lid',
  'u_sd','u_sd2','u_limbA[0]','u_limbB[0]','u_tendA[0]','u_tendB[0]','u_drop[0]',
  'u_skirt','u_droolA','u_droolB','u_fx',
  'u_zflat','u_lean','u_coreS','u_faceE','u_toon','u_mode',
  'u_bw','u_bf','u_sw','u_sf','u_smink',
  'u_palA','u_palB','u_palD','u_irid','u_glint','u_veins','u_scale','u_room','u_boundR',
  'u_amb','u_bands','u_facet','u_keyTint','u_filTint',
  'u_flow','u_flowPh','u_inkeye'];

// ── THE CONSOLE DIAL — PS1 swims, PS2 holds, PS3 cleans up. Resolution up,
// wobble down: vertex swim is the PS1 tell; later consoles held subpixel.
const QUALITY = {
  'ps1':  { div: 4,   maxW: 380, maxH: 240, wob: 1.00 },
  'ps2':  { div: 3,   maxW: 512, maxH: 336, wob: 0.45 },
  'ps2+': { div: 2,   maxW: 720, maxH: 450, wob: 0.15 },
  'ps3':  { div: 1.5, maxW: 960, maxH: 600, wob: 0.04 },
};

// ── AGENT STATES — bundles of face behavior, tempo and light. Doctrine:
// states may LIGHT the body (flow, fx) but never deform it.
// fx = [sonar rings, ember-through-matter, work streaks, drool]
const STATES = {
  IDLE:      { mood: 0.55, heat: 0.0, flow: 0.00, frate: 0.0, tempo: 1.00, antics: 1.0,  lid: 0.00, blink: 1.00, gaze: 'wander', fx: [0, 0, 0, 0] },
  LISTENING: { mood: 0.72, heat: 0.0, flow: 0.25, frate: 1.0, tempo: 0.90, antics: 0.0,  lid: 0.00, blink: 0.80, gaze: 'you', nod: true, fx: [1, 0, 0, 0] },
  RECORDING: { mood: 0.60, heat: 1.0, flow: 0.00, frate: 0.0, tempo: 1.00, antics: 0.0,  lid: 0.00, blink: 0.45, gaze: 'you', fx: [0, 1, 0, 0] },
  PAUSED:    { mood: 0.38, heat: 0.0, flow: 0.00, frate: 0.0, tempo: 0.45, antics: 0.15, lid: 0.38, blink: 0.60, gaze: 'low', fx: [0, 0, 0, 0] },
  RENDERING: { mood: 0.62, heat: 0.2, flow: 0.50, frate: 2.6, tempo: 0.70, antics: 0.0,  lid: 0.55, blink: 0.50, gaze: 'wander', shiver: true, fx: [0, 0, 1, 0] },
  SLEEPING:  { mood: 0.50, heat: 0.0, flow: 0.00, frate: 0.0, tempo: 0.30, antics: 0.0,  lid: 0.85, blink: 0.00, gaze: 'wander', fx: [0, 0, 0, 1] },
};

const TAU = Math.PI * 2;
const clamp1 = v => Math.max(-1, Math.min(1, v));

// THE SPLAT's rest anatomy (radians): left arm, head, right arm, right leg, left leg
const BASE_ANG = [2.618, 1.571, 0.436, -0.960, -2.182];

// ── SECOND-ORDER DYNAMICS (t3ssel8r's procedural-animation controller,
// credited: "Giving Personality to Procedural Animations using Math") —
// frequency f, damping z. A VECTOR system tracks a target array directly, so
// position AND velocity carry across re-targets: interrupting a pose mid-flight
// is smooth by construction. z < 1 gives the anticipation/overshoot/settle a
// smoothstep can't. Tunable mid-flight so each pose carries its own temperament.
function SODV(n, f, z) {
  let k1, k2;
  function tune(F, Z) { k1 = Z / (Math.PI * F); k2 = 1 / ((TAU * F) * (TAU * F)); }
  tune(f, z);
  const y = new Float64Array(n), yd = new Float64Array(n), xp = new Float64Array(n);
  return {
    tune,
    set(x) { for (let i = 0; i < n; i++) { y[i] = x[i]; xp[i] = x[i]; yd[i] = 0; } },
    step(T, x) {
      if (T > 0) {
        const k2s = Math.max(k2, T * T / 2 + T * k1 / 2, T * k1);   // stability clamp
        for (let i = 0; i < n; i++) {
          const xd = (x[i] - xp[i]) / T; xp[i] = x[i];
          y[i] += T * yd[i];
          yd[i] += T * (x[i] - y[i] - k1 * yd[i]) / k2s;
        }
      }
      return y;
    },
    speed() { let s = 0; for (let i = 0; i < n; i++) s += Math.abs(yd[i]); return s; },
  };
}

// ── POSES — the body's vocabulary. Each: per-limb [angle offset, length ×,
// radius ×] + meta: flat (3D blob -> 2D sticker), lean (the core goes WITH
// the pose), core (radius breath), and SOD motion temperament (f, z).
// Poses blend per the MORPH RULE and auto-return to the state's base pose.
const POSES = {
  NEUTRAL: { L: [[0,1,1],[0,1,1],[0,1,1],[0,1,1],[0,1,1]],
             flat: 0,    lean: [0, 0],      core: 1.00, f: 1.6, z: 0.95 },
  SPLAY:   { L: [[ 0.28,1.30,0.88],[0,1.22,0.88],[-0.28,1.30,0.88],[-0.20,1.18,0.90],[ 0.20,1.18,0.90]],
             flat: 1,    lean: [0, 0.03],   core: 0.92, f: 3.4, z: 0.50 },  // startle!
  ARMS_UP: { L: [[-0.35,1.30,0.92],[0,1.05,0.95],[ 0.35,1.30,0.92],[ 0.18,0.78,1.12],[-0.18,0.78,1.12]],
             flat: 1,    lean: [0, 0.05],   core: 0.95, f: 2.6, z: 0.60 },  // a take landed
  TUCK:    { L: [[ 0,0.60,1.35],[0,0.60,1.35],[0,0.60,1.35],[0,0.70,1.30],[ 0,0.70,1.30]],
             flat: 0.25, lean: [0, -0.05],  core: 1.18, f: 3.0, z: 0.65 },  // oof
  DROOP:   { L: [[ 0.55,0.90,1.00],[0.45,0.72,1.05],[-0.55,0.90,1.00],[-0.10,1.05,1.00],[ 0.10,1.05,1.00]],
             flat: 0.35, lean: [0, -0.07],  core: 1.00, f: 1.1, z: 1.10 },  // sleepy / sulking
  WAVE:    { L: [[ 0,1,1],[0,1,1],[ 0.70,1.45,0.82],[0,1,1],[0,1,1]],
             flat: 0.8,  lean: [0.03, 0],   core: 1.00, f: 2.2, z: 0.70 },  // one arm up (wiggles)
  REACH:   { L: [[ 0,1,1],[0,1,1],[ 0.18,1.55,0.78],[0,1,1],[0,1,1]],
             flat: 0.85, lean: [0.05, 0],   core: 0.97, f: 2.8, z: 0.70 },  // toward the thing
};
const POSE_NAMES = Object.keys(POSES);

// ── ANATOMY TUNE — the 3D-blob-vs-2D-emote dial:
//   restZ/emoteZ  z-flatten at rest / fully emoting
//   restLen       how absorbed the limbs sit at rest
//   tiltKeep      how much fore/aft limb tilt SURVIVES an emote (0 = goes flat)
const ANATOMY = {
  A: { restZ: 1.12, emoteZ: 1.45, restLen: 0.78, tiltKeep: 0.0 },   // 3D blob, flat emotes
  B: { restZ: 1.12, emoteZ: 1.20, restLen: 0.82, tiltKeep: 0.7 },   // always volumetric
  C: { restZ: 1.06, emoteZ: 1.52, restLen: 0.62, tiltKeep: 0.0 },   // sea-star: max contrast
};

function Moshi(host, opts = {}) {
  const O = Object.assign({
    personality: 'TAR', seed: 0.5, interactive: true, room: false,
    quality: 'ps2', style: 'ps2', resDiv: null, maxW: null, maxH: null, preserve: false,
  }, opts);

  const cv = document.createElement('canvas');
  cv.style.cssText = 'width:100%;height:100%;display:block;';
  host.appendChild(cv);

  let gl = null, prog = null, U = {}, dead = false;
  function initGL() {
    // opaque when he owns the frame (room mode) — cheaper composite; alpha
    // only for embeds. preserveDrawingBuffer defeats tile-discard on Apple
    // Silicon — off unless a harness asks (opts.preserve) to sample pixels.
    gl = cv.getContext('webgl', {
      antialias: false, alpha: !O.room, premultipliedAlpha: false,
      depth: false, stencil: false,                     // fullscreen-triangle raymarcher: no tile-memory tax
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
    gl.uniform1f(U.u_room, O.room ? 1 : 0);   // per-instance constant — upload once
    specDirty = true;                          // re-push the static spec set
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
    // THE CRUNCH IS THE POLICY: the buffer renders at CSS px / div on EVERY
    // display (never DPR-multiplied — a retina-smooth upscale smears the Bayer
    // lattice, and burns DPR² the fragments for a look defined as low-res).
    const W = Math.max(24, Math.min(O.maxW != null ? O.maxW : Q.maxW, Math.floor(r.width / div))),
          H = Math.max(24, Math.min(O.maxH != null ? O.maxH : Q.maxH, Math.floor(r.height / div)));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    // nearest upscale only when the buffer is genuinely being stretched
    // (>=1.25x); at ~1:1 'auto' avoids non-integer nearest shimmer.
    if (r.width / W >= 1.25) {
      cv.style.imageRendering = 'crisp-edges';
      cv.style.imageRendering = 'pixelated';
    } else {
      cv.style.imageRendering = 'auto';
    }
    if (gl) {
      gl.viewport(0, 0, W, H);
      gl.uniform3f(U.u_ires, W * 0.5, H * 0.5, 1 / Math.min(W, H));   // per-resize, not per-pixel
    }
  }
  const rob = new ResizeObserver(resize);
  rob.observe(host);
  const onScroll = () => { cvRect = null; };
  addEventListener('scroll', onScroll, { passive: true, capture: true });

  // ── state ──
  let from = makeSpec(O.personality, O.seed),
      to = from, mix = 1, cur = from;          // personality crossfade
  let specDirty = true;                        // static spec uniforms need a push
  // offscreen = invisible: scrolled out of view parks the rAF loop entirely
  let onScreen = true;
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(es => {
    const vis = es[0].isIntersecting;
    if (vis && !onScreen) { onScreen = true; last = performance.now(); raf = requestAnimationFrame(frame); }
    else if (!vis && onScreen) { onScreen = false; cancelAnimationFrame(raf); }
  }) : null;
  if (io) io.observe(cv);
  // v2: beat (beat-clock pulse) + flux (transient kick) join the drive set.
  // Both self-decay so a host can spike them and forget.
  const drives = { energy: 0.35, mood: 0.55, heat: 0.0, beat: 0.0, flux: 0.0 };
  const dCur = Object.assign({}, drives);
  let beatPh = 0;                              // integrated beat phase (MORPH RULE)
  let lph = 0, bph = 0, sph = 0;               // integrated phases (MORPH RULE)
  let rotA = 0, rotB = 0, rotTA = 0, rotTB = 0, spinV = 0;
  let wobA = 0, wobB = 0, tq = 0, lastTick = 0;
  let onsetEnv = 0, blink = 0, wide = 0, lid = 0, lidT = 0;
  let skept = 0, skeptT = 0;                   // v2: skeptical brow raise
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

  // agent state: behavior bundle + the flow/fx light (phases integrate — MORPH RULE)
  let stName = 'IDLE', st = STATES.IDLE, autoSlept = false;
  let flowA = 0, flowPh = 0, celebT = 0, celebE = 0;
  const fxA = [0, 0, 0, 0];                    // eased state-VFX amounts
  function setStateRaw(n) {
    stName = n; st = STATES[n]; autoSlept = false;
    drives.mood = st.mood; drives.heat = st.heat;   // baselines; hosts may override
    if (n === 'LISTENING' || n === 'RECORDING') fireBlink();  // acknowledgment
  }

  // ── the POSE engine: a vector second-order system tracks the target config
  // DIRECTLY (19 channels), so momentum carries across re-targets. ──
  const PN = 19;   // 5 limbs x [angle,len,rad] + flat + leanX + leanY + core
  function flattenPose(c, out) {
    for (let i = 0; i < 5; i++) { out[i*3] = c.L[i][0]; out[i*3+1] = c.L[i][1]; out[i*3+2] = c.L[i][2]; }
    out[15] = c.flat; out[16] = c.lean[0]; out[17] = c.lean[1]; out[18] = c.core;
  }
  const poseCfg = (n, aimX) => {
    const P = POSES[n];
    let L = P.L.map(l => l.slice());
    let lean = P.lean.slice();
    if ((n === 'REACH' || n === 'WAVE') && aimX < 0) {       // mirror to the left arm
      const t = L[2]; L[2] = [0, 1, 1];
      L[0] = [-t[0], t[1], t[2]];
      lean[0] = -lean[0];
    }
    return { L, flat: P.flat, lean, core: P.core };
  };
  let poseName = 'NEUTRAL', poseHold = 0;
  let seq = null, seqI = 0, seqT = 0;                  // impact-frame sequence player
  const poseTarget = new Float64Array(PN);
  flattenPose(poseCfg('NEUTRAL', 0), poseTarget);
  const poseV = SODV(PN, POSES.NEUTRAL.f, POSES.NEUTRAL.z);
  poseV.set(poseTarget);
  const poseOut = { L: [[1,1,1],[1,1,1],[1,1,1],[1,1,1],[1,1,1]], lean: [0,0], flat: 0, core: 1 };

  function applyPose(n, hold, aimX) {       // retarget — momentum preserved (fluid)
    if (!POSES[n]) throw new Error('moshi: unknown pose ' + n);
    flattenPose(poseCfg(n, aimX || 0), poseTarget);
    poseV.tune(POSES[n].f, POSES[n].z);     // per-pose temperament, no state reset
    poseName = n;
    poseHold = hold != null ? hold : 1.2;
  }
  function playSeq(steps) { seq = steps; seqI = 0; seqT = 0; applyPose(steps[0][0], 1e9, steps[0][2]); }
  function setPoseOne(n, hold, aimX) { seq = null; applyPose(n, hold, aimX); }
  const basePose = () => (stName === 'SLEEPING' || annoyT > 0) ? 'DROOP' : 'NEUTRAL';
  const limbA4 = new Float32Array(20);     // capsule starts + radii, baked per frame
  const limbB4 = new Float32Array(20);     // capsule ends
  const tendA4 = new Float32Array(24);     // v2: tendril chain segments (2 x 3)
  const tendB4 = new Float32Array(24);
  const drop4 = new Float32Array(24);      // v2: droplet spheres
  const shiftV = [0, 0, 0, 0, 0], tuckV = [0, 0, 0, 0, 0];
  let TUNE = Object.assign({}, ANATOMY.A);

  // ── v2 LIVING GOO — the droplet engine. Slots bud on the lower silhouette,
  // swell under surface tension, pinch off, fall, and reabsorb into the skirt.
  const ND = 6;
  const drops = [];
  for (let i = 0; i < ND; i++) drops.push({ m: 0, x: 0, y: -2, z: 0, r: 0, vx: 0, vy: 0, vz: 0, t: 0, pinch: 0 });
  let dropT = 2.5, skirtS = 0;
  function dropSlot() { for (let i = 0; i < ND; i++) if (drops[i].m === 0) return drops[i]; return null; }
  function budDrop() {
    const D = dropSlot(); if (!D) return;
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;    // the lower silhouette
    const rad = 0.34 + Math.random() * 0.06;
    D.m = 1; D.t = 0; D.r = 0.012; D.pinch = 0;
    D.x = Math.cos(ang) * rad; D.y = Math.sin(ang) * rad; D.z = (Math.random() - 0.5) * 0.12;
    D.vx = 0; D.vy = 0; D.vz = 0;
  }
  function burstDrop(n) {                       // celebrate: goo rains
    for (let i = 0; i < n; i++) {
      const D = dropSlot(); if (!D) return;
      const ang = Math.PI / 2 + (Math.random() - 0.5) * 2.4;   // off the crown
      D.m = 2; D.t = 0; D.pinch = 0;
      D.r = 0.028 + Math.random() * 0.030;
      D.x = Math.cos(ang) * 0.30; D.y = Math.sin(ang) * 0.30; D.z = (Math.random() - 0.5) * 0.16;
      D.vx = Math.cos(ang) * (0.5 + Math.random() * 0.6);
      D.vy = 1.1 + Math.random() * 0.9;
      D.vz = (Math.random() - 0.5) * 0.5;
    }
  }
  // ── v2 TENDRIL CROWN — two chains that sway with the drives and reach
  // toward the cursor when attention lands on it.
  let reach = 0;
  // ── v2 DROOL — the SLEEPING string; grows, detaches into a drop, regrows.
  let droolLen = 0;
  // dream twitch — a sleeping body is not a dead body
  let twitchT = 5 + Math.random() * 5;

  // the migration steal, splat edition: limbs fidget around their sockets —
  // bounded (an arm stays an arm), tucking in while they travel
  const lmb = [0, 1, 2, 3, 4].map(() => ({ s: 0, from: 0, tgt: 0, t0: 0, dur: 1, on: false }));
  let moveT = 6 + Math.random() * 8;
  function lobeMove(now) {
    const go = (i, tgt) => { const L = lmb[i]; L.from = L.s; L.tgt = Math.max(-0.28, Math.min(0.28, tgt)); L.t0 = now; L.dur = 1.3 + Math.random() * 1.5; L.on = true; };
    const r = Math.random();
    if (r < 0.45) go((Math.random() * 5) | 0, (Math.random() - 0.5) * 0.8);                // shuffle one
    else if (r < 0.72) { const i = (Math.random() * 5) | 0, j = (i + 1) % 5; const a = lmb[i].s; go(i, lmb[j].s); go(j, a); }  // neighbors trade
    else [0, 1, 2, 3, 4].forEach(i => go(i, lmb[i].s + (Math.random() - 0.5) * 0.4));      // scatter
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
      // grab-the-surface: the body FOLLOWS the cursor — yaw from horizontal,
      // pitch from vertical (drag down -> face tips down toward your cursor)
      rotTA -= dx * 0.006; rotTB += dy * 0.004;
      spinV = -dx * 0.10;                             // inertia source
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
  // the STYLE dial (eased so PS2<->TOON morphs, never snaps)
  const MODE_OF = { ps2: 0, toon: 0, baked: 1 };
  let toonA = O.style === 'ps2' ? 0 : 1, toonT = toonA;
  let modeT = MODE_OF[O.style] != null ? MODE_OF[O.style] : 0, modeA = modeT;

  // ── the loop ──
  let raf = 0, t0 = performance.now(), last = t0, lastGL = -1;
  function frame(now, force) {
    if (dead) return;
    const t = (now - t0) / 1000, dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // personality crossfade — fixed endpoints, eased
    if (mix < 1) {
      mix = Math.min(1, mix + dt / 1.1);
      const w = mix * mix * (3 - 2 * mix);
      cur = lerpSpec(from, to, w);
      if (mix >= 1) { from = to; cur = to; }
      specDirty = true;
    }
    for (const k in drives) dCur[k] += (drives[k] - dCur[k]) * Math.min(1, dt * 6);
    // v2: the pulsed drives decay on their own — hosts spike and forget
    drives.beat *= Math.pow(0.25, dt);
    drives.flux *= Math.pow(0.05, dt);
    beatPh += dt * (2.0 + 6.0 * dCur.beat + 2.0 * dCur.energy);

    // sleep: ignored long enough in IDLE, he drifts off. a NEAR touch wakes him.
    idleT += dt;
    if (O.interactive && stName === 'IDLE' && idleT > 45) { setStateRaw('SLEEPING'); autoSlept = true; }
    annoyT = Math.max(0, annoyT - dt);
    lidT = Math.max(st.lid, petting ? 0.65 : 0, annoyT > 0 ? 0.45 : 0);
    lid += (lidT - lid) * Math.min(1, dt * 3.5);
    // v2: the skeptical brow — earned by escalation, relaxes when forgiven
    skeptT = annoyT > 0 ? 1 : (pokeN >= 3 && now - pokeAt < 2500 ? 0.8 : 0);
    skept += (skeptT - skept) * Math.min(1, dt * 4);
    const tScale = st.tempo * (petting ? 0.6 : 1.0);
    flowA += (st.flow - flowA) * Math.min(1, dt * 2.5);
    flowPh += dt * st.frate * tScale;
    for (let i = 0; i < 4; i++) fxA[i] += (st.fx[i] - fxA[i]) * Math.min(1, dt * 2.5);
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
      interest += dt * Math.min(3, spd * 0.0035) * Math.max(0, 1.3 - dd) * habit;
    }
    prevPX = ptrX; prevPY = ptrY;
    interest *= Math.pow(0.25, dt);
    habit = Math.max(0.3, Math.min(1, habit + dt * (live && dd < 1.0 ? -0.12 : 0.2)));
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
          if (Math.random() < 0.35 && !seq) {  // …sometimes reaching toward it
            const R = rect();
            setPoseOne('REACH', 0.9, ptrX - (R.left + R.width / 2));
          }
        } else {                               // …or pointedly not.
          ignoreUntil = now + 1500;
          fireBlink();
        }
      }
      if (lookHold <= 0 && stName !== 'SLEEPING') retargetIdleGaze();
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

    // dream twitch — a sleeping body is not a dead body
    if (stName === 'SLEEPING') {
      twitchT -= dt;
      if (twitchT <= 0) {
        twitchT = 3.5 + Math.random() * 6;
        vy -= 0.9;
        const i = (Math.random() * 5) | 0;
        const L = lmb[i]; L.from = L.s; L.tgt = L.s + (Math.random() - 0.5) * 0.3;
        L.t0 = t; L.dur = 0.8; L.on = true;
      }
    }

    // lobe migration — IDLE-class business only; the body rearranges itself
    moveT -= dt;
    if (moveT <= 0 && st.antics > 0.2 && !petting) {
      lobeMove(t);
      moveT = (7 + Math.random() * 12) / Math.max(0.15, cur.restless);
    }
    for (let i = 0; i < 5; i++) {
      const L = lmb[i];
      if (L.on) {
        const ph = Math.min((t - L.t0) / L.dur, 1);
        const e = ph * ph * (3 - 2 * ph);
        L.s = L.from + (L.tgt - L.from) * e;
        tuckV[i] = Math.sin(ph * Math.PI);
        if (ph >= 1) { L.s = L.tgt; L.on = false; }
      } else tuckV[i] = 0;
      shiftV[i] = L.s;
    }

    // impact-frame sequence player advances by time; the SODV smooths the arc
    if (seq) {
      seqT += dt;
      if (seqT >= seq[seqI][1]) {
        seqT = 0; seqI++;
        if (seqI >= seq.length) { seq = null; poseHold = 0.35; }
        else applyPose(seq[seqI][0], 1e9, seq[seqI][2]);
      }
    }
    const py = poseV.step(dt, poseTarget);
    for (let i = 0; i < 5; i++) { poseOut.L[i][0] = py[i*3]; poseOut.L[i][1] = py[i*3+1]; poseOut.L[i][2] = py[i*3+2]; }
    poseOut.flat = py[15]; poseOut.lean[0] = py[16]; poseOut.lean[1] = py[17]; poseOut.core = py[18];
    const pose = poseOut;
    if (!seq && poseV.speed() < 0.4) {
      poseHold -= dt;
      if (poseHold <= 0 && poseName !== basePose()) applyPose(basePose(), 0);
    }
    if (poseName === 'WAVE') {
      const armi = Math.abs(poseTarget[7] - 1) > 0.1 ? 2 : 0;
      pose.L[armi][0] += Math.sin(t * 9) * 0.22;
    }
    const faceE = Math.min(1, poseV.speed() * 0.05 + pose.flat * 0.3);

    // the style dial eases
    toonA += (toonT - toonA) * Math.min(1, dt * 4);
    modeA += (modeT - modeA) * Math.min(1, dt * 4);

    // he WANTS to face you: drag/antics swing him away, he eases home
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

    // ── v2 LIVING GOO: bud, swell, pinch, fall, reabsorb ──
    dropT -= dt * (0.35 + dCur.energy * 1.6 + fxA[3] * 0.4);
    if (dropT <= 0 && stName !== 'SLEEPING') { budDrop(); dropT = 2.2 + Math.random() * 3.5; }
    for (let i = 0; i < ND; i++) {
      const D = drops[i];
      if (D.m === 1) {                                    // budding on the skin
        D.t += dt;
        D.r = Math.min(0.055, D.r + dt * 0.030);
        D.y -= dt * 0.022;                                // heavy: slides down
        D.pinch = Math.min(1, D.t * 0.8);
        if (D.r >= 0.054 && D.t > 1.1 + (i % 3) * 0.4) { D.m = 2; D.vy = 0; D.r *= 0.88; }
      } else if (D.m === 2) {                             // falling
        D.vy -= 3.2 * dt;
        D.x += D.vx * dt; D.y += D.vy * dt; D.z += D.vz * dt;
        if (D.y < -0.52) {                                // lands: the skirt swells
          skirtS = Math.min(0.30, skirtS + D.r * 2.0);
          D.m = 0; D.r = 0; D.y = -2;
        }
      }
      drop4[i * 4] = D.x; drop4[i * 4 + 1] = D.y; drop4[i * 4 + 2] = D.z;
      drop4[i * 4 + 3] = D.m > 0 ? D.r : 0;
    }
    skirtS *= Math.pow(0.55, dt);                         // he pulls it back in

    // ── v2 DROOL: grows while he sleeps, lets go, regrows ──
    if (fxA[3] > 0.4) {
      droolLen += dt * 0.055;
      if (droolLen > 0.42) {                              // the string lets go
        const D = dropSlot();
        if (D) { D.m = 2; D.t = 0; D.r = 0.030; D.x = 0.02; D.y = -0.20 - droolLen; D.z = 0.22; D.vx = 0; D.vy = 0; D.vz = 0; }
        droolLen = 0.04;
      }
    } else droolLen = Math.max(0, droolLen - dt * 0.6);

    // ── v2 TENDRIL CROWN: sway with the drives, reach for the cursor ──
    const reachGoal = (att === 'cursor') ? 1 : 0;
    reach += (reachGoal - reach) * Math.min(1, dt * 3);
    {
      const lens = [0.20, 0.17, 0.14], rads = [0.036, 0.026, 0.016];
      const jAmt = 0.06 + 0.30 * dCur.energy + 0.35 * dCur.beat + 0.45 * dCur.flux;
      const aimX = gazeT.x * 1.1, aimY = gazeT.y * 0.9 + 0.15;
      for (let ti = 0; ti < 2; ti++) {
        const side = ti === 0 ? -1 : 1;
        let px = side * 0.13 + pose.lean[0] * 0.6, py = 0.26 + pose.lean[1] * 0.6, pz = 0.05;
        let dx = side * 0.48, dy = 0.85, dz = 0.25;
        for (let s = 0; s < 3; s++) {
          const sw = Math.sin(t * (1.6 + ti * 0.3) + s * 1.4 + ti * 2.1) * jAmt;
          const sw2 = Math.cos(t * (1.2 + ti * 0.2) + s * 1.1 + ti) * jAmt * 0.7;
          dx += sw * 0.9 + (aimX * 1.2 - dx) * reach * 0.55;
          dy += sw2 * 0.5 - s * 0.11 - reach * 0.28 + (aimY - dy) * reach * 0.40;
          dz += reach * 0.30;
          const il = 1 / (Math.hypot(dx, dy, dz) || 1);
          dx *= il; dy *= il; dz *= il;
          const k = (ti * 3 + s) * 4;
          tendA4[k] = px; tendA4[k + 1] = py; tendA4[k + 2] = pz; tendA4[k + 3] = rads[s];
          px += dx * lens[s]; py += dy * lens[s]; pz += dz * lens[s];
          tendB4[k] = px; tendB4[k + 1] = py; tendB4[k + 2] = pz; tendB4[k + 3] = 0;
        }
      }
    }

    // render-rate governor: the sim stays full-rate; the GL block throttles
    // down when nothing happens — SLEEPING at the 12fps wobble clock's own
    // rate, PAUSED at 30.
    const glGap = stName === 'SLEEPING' && !dragAt && !petting ? 1 / 12
                : stName === 'PAUSED' ? 1 / 30 : 0;
    if (!force && glGap && t - lastGL < glGap) { raf = requestAnimationFrame(frame); return; }
    lastGL = t;

    // CPU-side frame constants
    const sd = cur.sd, sd2 = cur.sd2;
    const lA = rotA + wobA;
    const lB = rotB + wobB + (st.nod ? Math.sin(t * 2.1) * 0.02 : 0);
    const scaleEff = cur.scale * breathe;

    if (!O.room) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.uniform1f(U.u_tq, tq);
    gl.uniform1f(U.u_lph, lph);
    gl.uniform1f(U.u_bph, bph);
    gl.uniform1f(U.u_sph, sph);
    gl.uniform4f(U.u_rotM, Math.cos(lA), Math.sin(lA), Math.cos(lB), Math.sin(lB));
    gl.uniform4f(U.u_pulse, Math.sin(tq * 3.5), Math.sin(t * 1.5 + 1.7), Math.sin(t * 1.5), 0);
    {
      const mt = cur.tilt * (0.5 + 0.5 * dCur.mood) - (annoyT > 0 ? 0.22 : 0);
      gl.uniform2f(U.u_mtiltCS, Math.cos(mt), Math.sin(mt));
    }
    gl.uniform1f(U.u_onset, onsetEnv);
    gl.uniform1f(U.u_energy, Math.min(1, dCur.energy + celebE));
    gl.uniform1f(U.u_mood, dCur.mood);
    gl.uniform1f(U.u_heat, dCur.heat);
    gl.uniform1f(U.u_beat, dCur.beat);
    gl.uniform1f(U.u_beatPh, beatPh);
    gl.uniform1f(U.u_flux, dCur.flux);
    gl.uniform1f(U.u_skept, skept);
    {
      const wrapA = Math.atan2(Math.sin(rotA), Math.cos(rotA));
      gl.uniform2f(U.u_gaze,
        clamp1(gaze.x - wrapA * 0.55 + Math.sin(t * 7.3) * 0.012),
        clamp1(gaze.y - rotB * 0.55 + Math.sin(t * 8.1 + 2.0) * 0.010));
    }
    gl.uniform2f(U.u_sq, sx, syF);
    gl.uniform1f(U.u_blink, Math.min(1, blink));
    gl.uniform1f(U.u_wide, Math.min(1, wide));
    gl.uniform1f(U.u_lid, lid);
    // THE SPLAT's limbs: anatomy × pose × fidget × breath-drift, baked on CPU
    const restEase = TUNE.restLen + (1 - TUNE.restLen) * pose.flat;
    for (let i = 0; i < 5; i++) {
      const P = pose.L[i];
      const ang = cur.limbA[i] + P[0] + shiftV[i] + Math.sin(lph * 0.9 + i * 2.1) * 0.05;
      const len = cur.limbL[i] * P[1] * restEase * (1 - 0.18 * tuckV[i]) * (1 + Math.sin(lph * 0.7 + i * 1.7) * 0.04);
      const tlt = cur.limbT[i] * (1 - pose.flat * (1 - TUNE.tiltKeep));
      const ct = Math.cos(tlt);
      const dx = Math.cos(ang) * ct, dy = Math.sin(ang) * ct, dz = Math.sin(tlt);
      limbA4[i * 4]     = dx * 0.10 + pose.lean[0];
      limbA4[i * 4 + 1] = dy * 0.10 + pose.lean[1];
      limbA4[i * 4 + 2] = dz * 0.10;
      limbA4[i * 4 + 3] = cur.limbR[i] * P[2] * (1 + 0.12 * tuckV[i]);
      limbB4[i * 4]     = dx * len + pose.lean[0];
      limbB4[i * 4 + 1] = dy * len + pose.lean[1];
      limbB4[i * 4 + 2] = dz * len;
      limbB4[i * 4 + 3] = 0;
    }
    gl.uniform4fv(U['u_limbA[0]'], limbA4);
    gl.uniform4fv(U['u_limbB[0]'], limbB4);
    gl.uniform4fv(U['u_tendA[0]'], tendA4);
    gl.uniform4fv(U['u_tendB[0]'], tendB4);
    gl.uniform4fv(U['u_drop[0]'], drop4);
    // the ground skirt he spreads and reabsorbs into (bigger when he sleeps)
    gl.uniform4f(U.u_skirt, pose.lean[0] * 0.3, -0.48, 0.0,
                 0.085 + skirtS * 0.55 + (stName === 'SLEEPING' ? 0.03 : 0));
    // the drool string + its heavy tip
    const dA = fxA[3] * 0.016, dB = droolLen > 0.18 ? 0.028 : 0.0;
    gl.uniform4f(U.u_droolA, 0.03, -0.16, 0.235, dA);
    gl.uniform4f(U.u_droolB, 0.03, -0.16 - droolLen, 0.22, dB);
    gl.uniform4f(U.u_fx, fxA[0], fxA[1], fxA[2], fxA[3]);
    gl.uniform1f(U.u_zflat, TUNE.restZ + (TUNE.emoteZ - TUNE.restZ) * pose.flat);
    gl.uniform2f(U.u_lean, pose.lean[0], pose.lean[1]);
    gl.uniform1f(U.u_coreS, pose.core);
    gl.uniform1f(U.u_faceE, faceE);
    gl.uniform1f(U.u_toon, toonA);
    gl.uniform1f(U.u_mode, modeA);
    gl.uniform1f(U.u_smink, cur.k * (1 + 0.30 * (1 - pose.flat)));
    gl.uniform1f(U.u_scale, scaleEff);
    // the body is bounded in its own frame (map() clamps at 1.35 — the crown
    // reaches past the old unit sphere); world extent scales + a lean margin
    gl.uniform1f(U.u_boundR, scaleEff * Math.max(sx, syF, 1) * 1.35 + 0.12);
    // static spec set — pushed only on crossfade/reroll
    if (specDirty) {
      specDirty = false;
      gl.uniform1f(U.u_sd, sd);
      gl.uniform1f(U.u_sd2, sd2);
      gl.uniform1f(U.u_bw, cur.bw);
      gl.uniform1f(U.u_bf, cur.bf);
      gl.uniform1f(U.u_sw, cur.sw);
      gl.uniform1f(U.u_sf, cur.sf);
      gl.uniform3f(U.u_palA, cur.palA[0], cur.palA[1], cur.palA[2]);
      gl.uniform3f(U.u_palB, cur.palB[0], cur.palB[1], cur.palB[2]);
      gl.uniform3f(U.u_palD, cur.palD[0], cur.palD[1], cur.palD[2]);
      gl.uniform1f(U.u_irid, cur.irid);
      gl.uniform1f(U.u_glint, cur.glint);
      gl.uniform1f(U.u_veins, cur.veins);
      gl.uniform1f(U.u_inkeye, cur.ink);
      gl.uniform1f(U.u_amb, cur.amb);
      gl.uniform1f(U.u_bands, cur.bands);
      gl.uniform1f(U.u_facet, cur.facet);
      gl.uniform3f(U.u_keyTint, cur.keyT[0], cur.keyT[1], cur.keyT[2]);
      gl.uniform3f(U.u_filTint, cur.filT[0], cur.filT[1], cur.filT[2]);
    }
    gl.uniform1f(U.u_flow, flowA);
    gl.uniform1f(U.u_flowPh, flowPh);
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
      if (o && o.snap) {
        from = to = cur = makeSpec(nm, sd); mix = 1;
      } else {
        from = cur === to ? to : lerpSpec(from, to, mix * mix * (3 - 2 * mix));
        to = makeSpec(nm, sd); mix = 0;
      }
      specDirty = true;
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
    celebrate() {                    // a take landed — arms up, goo rains down
      celebT = 1.5; celebE = 1;
      wide = 1; vy -= 5.2;
      rotTA += (Math.random() - 0.5) * 1.6;
      playSeq([['TUCK', 0.07, 0], ['ARMS_UP', 1.4, 0]]);   // wind-up, then up
      burstDrop(4 + (Math.random() * 3 | 0));              // v2: the burst
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
        setPoseOne('DROOP', 4);                  // everything sags. happy now?
        ignoreUntil = now + 6000;
        return api;
      }
      if (pokeN >= 3) {                          // genuinely startled now
        wide = 1; vy -= 5.5; onsetEnv = Math.min(1.2, onsetEnv + 1.0);
        fireBlink(); setTimeout(() => { if (!dead) blink = 1; }, 220);
        rotTA += (Math.random() - 0.5) * 1.0;
        playSeq([['TUCK', 0.06, 0], ['SPLAY', 0.7, 0]]);
        return api;
      }
      const r = Math.random() * (0.85 + 0.45 * cur.antic);
      if (r < 0.35) {                            // classic startle-hop
        onsetEnv = Math.min(1.2, onsetEnv + 0.8); wide = 1; vy -= 4.2;
        rotTA += (Math.random() - 0.5) * 0.7;
        playSeq([['TUCK', 0.05, 0], ['SPLAY', 0.5, 0]]);
      } else if (r < 0.6) {                      // squash-oof: tiny rise, then compress
        vy += 4.5; onsetEnv = Math.min(1.2, onsetEnv + 0.6);
        fireBlink(); setTimeout(() => { if (!dead) blink = 1; }, 200);
        playSeq([['SPLAY', 0.04, 0], ['TUCK', 0.5, 0]]);
      } else if (r < 0.85) {                     // double-take: the spot, then YOU
        vy -= 1.5;
        saccadeTo(px, py, 0.38);
        setPoseOne('REACH', 0.9, px);
        setTimeout(() => {
          if (dead) return;
          saccadeTo(0, 0.06, 1.5); wide = 0.6; fireBlink();
        }, 380);
      } else {                                   // delight-bounce: tongue out, arms up
        vy -= 3.5; wide = 0.9; celebE = Math.max(celebE, 0.5);
        drives.mood = 1;
        rotTA += (Math.random() - 0.5) * 1.2;
        playSeq([['TUCK', 0.05, 0], ['ARMS_UP', 0.7, 0]]);
      }
      return api;
    },
    setPose(n, hold) {
      setPoseOne(String(n).toUpperCase(), hold != null ? hold : 2.5,
                 gaze.x);                        // REACH/WAVE aim where he's looking
      return api;
    },
    setStyle(s) {
      if (MODE_OF[s] == null) throw new Error('moshi: unknown style ' + s);
      O.style = s;
      toonT = s === 'ps2' ? 0 : 1;     // ps2 = dithered crunch; everything else clean
      modeT = MODE_OF[s];              // solid / baked — eased crossfade
      return api;
    },
    setAnatomy(n) {                  // A / B / C — the 3D-vs-flat variations
      if (!ANATOMY[n]) throw new Error('moshi: unknown anatomy ' + n);
      TUNE = Object.assign({}, ANATOMY[n]);
      O.anatomy = n;
      return api;
    },
    lookAt(nx, ny) { saccadeTo(nx, ny, 2); ignoreUntil = performance.now() + 2000; return api; },
    state() { return { personality: to.name, seed: to.seed, state: stName, pose: poseName, style: O.style, quality: O.quality, petting, attention: att, drives: Object.assign({}, drives) }; },
    _move() { lobeMove((performance.now() - t0) / 1000); return api; },   // test hook
    onPersonality(fn) { onChange = fn; return api; },
    _step() {                       // one synchronous frame — for harnesses
      cancelAnimationFrame(raf);    // whose rAF is throttled (tests, captures)
      frame(performance.now(), true);          // forced: ignores the governor
      return api;
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf); clearTimeout(blinkTimer); rob.disconnect();
      if (io) io.disconnect();
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
Moshi.POSES = POSE_NAMES.slice();
Moshi.STYLES = ['ps2', 'toon', 'baked'];
Moshi.ANATOMIES = Object.keys(ANATOMY);
window.Moshi = Moshi;
})();
