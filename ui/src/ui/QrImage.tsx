import { useEffect, useState } from "react";
import * as QRCode from "qrcode";

// The one QR renderer every pairing surface uses (the v2 iPhone dialog, the topbar
// companion popover, the V3 Phone launcher). Extracted so all three encode the SAME
// thing — `pairing.padUrl`, the LAN-IP Safari pad at /pad — rather than each shell
// picking a URL for itself. Rendering is async (toDataURL), so callers get either the
// image or the `waitClassName` placeholder, never a half-drawn code.
export function QrImage({
  url,
  size = 240,
  className,
  waitClassName,
  alt = "Pairing QR",
  testId,
}: {
  url: string;
  size?: number;
  className?: string;
  waitClassName?: string;
  alt?: string;
  testId?: string;
}) {
  const [dataUrl, setDataUrl] = useState("");
  useEffect(() => {
    let cancelled = false;
    setDataUrl("");
    void QRCode.toDataURL(url, { margin: 1, width: size, color: { dark: "#0b0b0b", light: "#ccff23" } })
      .then((d) => { if (!cancelled) setDataUrl(d); })
      .catch(() => { if (!cancelled) setDataUrl(""); });
    return () => { cancelled = true; };
  }, [url, size]);

  if (dataUrl) return <img className={className} src={dataUrl} alt={alt} data-testid={testId} />;
  return waitClassName ? <div className={waitClassName} aria-hidden="true" /> : null;
}
