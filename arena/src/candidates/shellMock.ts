// A believable Mosh-shell mockup built from the shared kit tokens + the shell fixture.
// Each whole-shell candidate injects its own `look` CSS on top of this common skeleton,
// so we compare LOOKS on identical structure/content. Self-contained: the little canvas
// waveforms + moving playhead run inside the sandbox via inline script (reads window.__mosh).

const LANES = [
  { name: "Drums", icon: "▣", clips: [[0, 16], [16, 16], [48, 8]] },
  { name: "Bass", icon: "◉", clips: [[0, 32], [40, 16]] },
  { name: "Keys", icon: "▤", clips: [[8, 24], [40, 20]] },
  { name: "Vox", icon: "◈", clips: [[16, 16], [40, 24]] },
];
const TOTAL = 64;

function laneBodies(): string {
  return LANES.map((l, li) =>
    `<div class="s-lanebody">` +
    l.clips
      .map(
        ([s, len], ci) =>
          `<div class="s-clip s-clip-${li}" style="left:${(s / TOTAL) * 100}%;width:${(len / TOTAL) * 100}%">` +
          `<canvas data-wave data-seed="${1 + li * 0.7 + ci * 0.3}"></canvas></div>`,
      )
      .join("") +
    `</div>`,
  ).join("");
}

function heads(): string {
  return (
    `<div class="s-rspacer"></div>` +
    LANES.map(
      (l) =>
        `<div class="s-lh"><div class="s-licon">${l.icon}</div>` +
        `<div class="s-lmeta"><b>${l.name}</b><span>chain</span></div>` +
        `<div class="s-ms"><i>M</i><i>S</i></div></div>`,
    ).join("")
  );
}

const SCRIPT = `<script>
(function(){
 function accent(){return getComputedStyle(document.documentElement).getPropertyValue('--v2-accent').trim()||'#ccff36';}
 function waveCol(){return getComputedStyle(document.documentElement).getPropertyValue('--wave').trim()||accent();}
 function draw(cv){var ctx=cv.getContext('2d');if(!ctx)return;var dpr=Math.min(devicePixelRatio||1,2);
  var w=cv.clientWidth,h=cv.clientHeight;if(!w||!h)return;cv.width=w*dpr;cv.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
  var mid=h/2,sd=parseFloat(cv.getAttribute('data-seed'))||1;ctx.clearRect(0,0,w,h);ctx.fillStyle=waveCol();
  for(var x=0;x<w;x++){var t=x/w;var a=Math.abs(Math.sin(t*17.0*sd)+0.5*Math.sin(t*41.0*sd+sd));
   a=Math.min(1,a*(0.35+0.65*Math.abs(Math.sin(t*6.283*4))));var hh=a*mid*0.92;ctx.fillRect(x,mid-hh,1,hh*2);}}
 var cvs=[].slice.call(document.querySelectorAll('canvas[data-wave]'));
 function redraw(){cvs.forEach(draw);}redraw();addEventListener('resize',redraw);
 var ph=document.querySelector('.s-ph'),content=document.querySelector('.s-content'),orb=document.querySelector('.s-orb');
 function frame(){var m=window.__mosh||{};var p=m.playhead||0;
  if(ph&&content){ph.style.transform='translateX('+(p*content.clientWidth)+'px)';}
  if(orb){var g=0.5+0.5*Math.sin((m.time||0)*2.2);orb.style.filter='brightness('+(0.9+g*0.5)+')';}
  requestAnimationFrame(frame);}requestAnimationFrame(frame);
})();
<\/script>`;

const BASE = `
.s{position:absolute;inset:0;display:grid;grid-template-rows:56px 1fr;font-family:var(--font-body);color:var(--v2-text);background:var(--v2-bg);overflow:hidden}
.s-top{display:flex;align-items:center;gap:16px;padding:0 18px;border-bottom:1px solid var(--v2-line)}
.s-brand{font-family:var(--font-display);font-weight:800;font-size:16px;letter-spacing:.06em}
.s-brand em{font-style:normal;color:var(--v2-accent)}
.s-pill{display:flex;align-items:center;gap:9px;margin:0 auto;padding:5px 8px;border-radius:999px;border:1px solid var(--v2-line);background:var(--v2-ground-card)}
.s-tb{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--v2-line);background:var(--v2-surface-sunken);color:var(--v2-text);font-size:10px}
.s-tb.play{background:var(--v2-accent);color:var(--v2-accent-ink);border-color:transparent;font-weight:700}
.s-tb.rec{color:var(--v2-rec)}
.s-time{font-family:var(--font-mono);font-size:15px;letter-spacing:.04em;padding-left:6px}
.s-time small{color:var(--v2-dim);font-size:9px;letter-spacing:.12em}
.s-av{display:flex;padding-left:4px}
.s-av i{width:24px;height:24px;border-radius:50%;border:2px solid var(--v2-ground);margin-left:-9px;display:block;background:linear-gradient(135deg,#8ea0ff,#c98bff)}
.s-av i:nth-child(2){background:linear-gradient(135deg,#ffcf6b,#ff7a9c)}
.s-invite{font-size:10px;letter-spacing:.1em;color:var(--v2-accent-ink);background:var(--v2-accent);border:0;border-radius:8px;padding:7px 11px;font-weight:700}
.s-body{display:grid;grid-template-columns:44px 1fr 262px;min-height:0}
.s-tab{border-right:1px solid var(--v2-line);display:flex;flex-direction:column;align-items:center;gap:16px;padding-top:16px;color:var(--v2-dim);font-size:14px}
.s-main{display:grid;grid-template-rows:32px 1fr auto;min-height:0;padding:14px;gap:12px}
.s-nav{border-radius:10px;border:1px solid var(--v2-line);background:var(--v2-surface);display:flex;align-items:center;padding:0 12px;gap:8px;font-family:var(--font-mono);font-size:10px;color:var(--v2-dim);letter-spacing:.1em}
.s-nav .dot{width:6px;height:6px;border-radius:50%;background:var(--v2-accent)}
.s-stage{position:relative;display:grid;grid-template-columns:150px 1fr;border:1px solid var(--v2-line);border-radius:16px;background:var(--v2-surface);box-shadow:var(--v2-shadow);overflow:hidden;min-height:0}
.s-heads{border-right:1px solid var(--v2-line);display:grid;grid-template-rows:24px repeat(4,1fr);background:var(--v2-surface-2)}
.s-rspacer{border-bottom:1px solid var(--v2-line)}
.s-lh{display:flex;align-items:center;gap:9px;padding:0 11px;border-bottom:1px solid var(--v2-line)}
.s-licon{width:28px;height:28px;border-radius:8px;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.01));border:1px solid var(--v2-line);color:var(--v2-accent);display:grid;place-items:center;font-size:12px}
.s-lmeta{display:flex;flex-direction:column;line-height:1.25}
.s-lmeta b{font-size:12px;font-weight:600}
.s-lmeta span{font-size:8.5px;color:var(--v2-faint);letter-spacing:.08em;text-transform:uppercase}
.s-ms{margin-left:auto;display:flex;gap:4px}
.s-ms i{width:16px;height:16px;border-radius:5px;border:1px solid var(--v2-line);display:grid;place-items:center;font-size:8px;color:var(--v2-dim);font-style:normal}
.s-content{position:relative;display:grid;grid-template-rows:24px repeat(4,1fr)}
.s-ruler{border-bottom:1px solid var(--v2-line);display:flex;align-items:center;gap:0;font-family:var(--font-mono);font-size:8.5px;color:var(--v2-faint)}
.s-ruler b{flex:1;padding-left:6px;border-left:1px solid var(--v2-line);font-weight:400}
.s-lanebody{position:relative;border-bottom:1px solid var(--v2-line)}
.s-clip{position:absolute;top:8px;bottom:8px;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.14);box-shadow:0 3px 12px rgba(0,0,0,.35);background:var(--v2-clip-block)}
.s-clip-0{background:rgba(24,24,26,.66);border-color:color-mix(in srgb,var(--v2-accent) 30%,transparent)}
.s-clip-1{background:rgba(26,26,28,.66)}
.s-clip canvas{width:100%;height:100%;display:block;opacity:.9}
.s-ph{position:absolute;top:24px;bottom:0;left:0;width:2px;background:var(--v2-playhead);box-shadow:0 0 12px var(--v2-playhead);will-change:transform}
.s-rail{border-left:1px solid var(--v2-line);padding:14px;display:flex;flex-direction:column;gap:12px;min-height:0}
.s-card{border:1px solid var(--v2-line);border-radius:16px;background:var(--v2-surface);padding:12px;box-shadow:var(--v2-glow)}
.s-orb{width:66px;height:66px;border-radius:50%;margin:4px auto 8px;background:radial-gradient(circle at 38% 34%,var(--v2-accent),#0b0b0b 72%);box-shadow:0 0 30px var(--v2-accent-soft),inset 0 0 0 1px rgba(255,255,255,.06)}
.s-status{text-align:center;font-family:var(--font-mono);font-size:9px;letter-spacing:.14em;color:var(--v2-accent);text-transform:uppercase}
.s-row{display:flex;align-items:center;justify-content:space-between;font-size:10.5px;color:var(--v2-dim);padding:6px 0;border-bottom:1px solid var(--v2-line)}
.s-row b{color:var(--v2-text);font-weight:600;font-variant-numeric:tabular-nums}
.s-comp{margin:0 auto;width:min(560px,100%);display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:16px;border:1px solid var(--v2-line);background:linear-gradient(180deg,var(--v2-surface-2),var(--v2-surface));box-shadow:var(--v2-glow)}
.s-spark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--v2-accent-soft);color:var(--v2-accent);font-size:15px}
.s-comp input{flex:1;background:transparent;border:0;outline:0;color:var(--v2-text);font:inherit;font-size:12.5px}
.s-comp input::placeholder{color:var(--v2-faint)}
.s-send{width:30px;height:30px;border-radius:9px;border:0;background:var(--v2-accent);color:var(--v2-accent-ink);font-size:13px}
`;

export function shellMock(look: string): string {
  return `<style>${BASE}${look}</style>
<div class="s">
  <div class="s-top">
    <div class="s-brand">MOSH<em>·</em></div>
    <div class="s-pill">
      <div class="s-tb">⏮</div><div class="s-tb play">▶</div><div class="s-tb">◼</div><div class="s-tb rec">●</div>
      <div class="s-time">005·2·01 <small>BARS</small></div>
    </div>
    <div class="s-av"><i></i><i></i></div>
    <button class="s-invite">INVITE</button>
  </div>
  <div class="s-body">
    <div class="s-tab"><span>≡</span><span>♪</span><span>◇</span></div>
    <div class="s-main">
      <div class="s-nav"><span class="dot"></span>MIDNIGHT DRIVE · 122 BPM · F MIN</div>
      <div class="s-stage">
        <div class="s-heads">${heads()}</div>
        <div class="s-content">
          <div class="s-ruler"><b>1</b><b>2</b><b>3</b><b>4</b><b>5</b><b>6</b><b>7</b><b>8</b></div>
          ${laneBodies()}
          <div class="s-ph"></div>
        </div>
      </div>
      <div class="s-comp">
        <div class="s-spark">✦</div>
        <input placeholder="Ask Mosh to warm up the keys and add a tape flutter…" />
        <button class="s-send">↑</button>
      </div>
    </div>
    <div class="s-rail">
      <div class="s-card">
        <div class="s-orb"></div>
        <div class="s-status">● live · listening</div>
      </div>
      <div class="s-card">
        <div class="s-row"><span>Volume</span><b>−4.0 dB</b></div>
        <div class="s-row"><span>Pan</span><b>C</b></div>
        <div class="s-row" style="border:0"><span>Output</span><b>Master</b></div>
      </div>
    </div>
  </div>
</div>
${SCRIPT}`;
}
