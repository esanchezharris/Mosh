// Renders one peer's (or your own) live video into a <video>. The MediaStream is bound
// imperatively via srcObject (it's not a serializable prop). Self-preview is muted to
// avoid feedback; remote tiles carry no audio in v1 (video-only).

import { useEffect, useRef } from "react";

export function VideoTile({ stream, muted, label }: { stream: MediaStream; muted?: boolean; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
    return () => { if (el) el.srcObject = null; };
  }, [stream]);
  return (
    <video
      ref={ref}
      className="video-tile"
      data-testid="video-tile"
      autoPlay
      playsInline
      muted={muted}
      aria-label={label ?? "Video"}
    />
  );
}
