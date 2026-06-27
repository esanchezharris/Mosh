// A tiny live audio-level meter for a peer's presence card. Taps the stream's AUDIO
// track via a Web Audio AnalyserNode and animates a few bars off the running RMS — all
// client-side, no backend. If the stream is video-only (the v1 case) there's no audio
// track to read, so it renders nothing rather than a dead flat row. Self-tears-down the
// AudioContext + rAF on unmount.

import { useEffect, useRef } from "react";

const BARS = 5;

export function PresenceMeter({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLDivElement>(null);
  const hasAudio = stream.getAudioTracks().length > 0;

  useEffect(() => {
    if (!hasAudio || !ref.current) return;
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctx) return;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const bars = Array.from(ref.current.children) as HTMLElement[];
    let raf = 0;
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      // crude per-bar average across contiguous bins → a chunky, level-driven look
      const per = Math.floor(buf.length / BARS);
      for (let i = 0; i < BARS; i++) {
        let sum = 0;
        for (let j = 0; j < per; j++) sum += buf[i * per + j];
        const v = Math.min(1, (sum / per) / 180);
        if (bars[i]) bars[i].style.transform = `scaleY(${0.18 + v * 0.82})`;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); src.disconnect(); void ctx.close(); };
  }, [stream, hasAudio]);

  if (!hasAudio) return null;
  return (
    <div className="v2-meter" ref={ref} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => <span key={i} />)}
    </div>
  );
}
