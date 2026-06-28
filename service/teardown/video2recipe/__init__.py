"""§4 Video → recipe-skeleton. Acquire a tutorial (yt-dlp), sample keyframes (cadence +
scene cuts), OCR transport/title/plugin text → tempo/key/DAW/plugins, transcribe narration
(faster-whisper), and assemble a schema-valid §0 Recipe skeleton (always valid — nulls +
`unresolved` on partial failure). §5/§5b/§7 fill the elements; this lays the frame.

Pure cores (ocr parsing, assemble) are hermetically tested; acquire/transcribe/keyframe
extraction are gated on yt-dlp/faster-whisper/cv2 + the network.
"""
from .ocr import parse_key, parse_plugins, parse_tempo, scan_meta  # noqa: F401
from .assemble import assemble_skeleton  # noqa: F401
