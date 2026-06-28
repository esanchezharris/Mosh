"""§3 Sourcing / scouting — discover beat tutorials at scale and score each by predicted
recipe-yield, so §10 pulls the richest first. Discovery uses yt-dlp's own search
(`ytsearch:`) — no Data API key — and media is treated as a transient, hash-recorded
analysis cache, never a retained/redistributed corpus (posture.py). The pure core
(catalog/posture/prescreen/score) is hermetically testable; the real yt-dlp fetch is
gated on the dep, exactly like SA3/transform.
"""
from .catalog import Catalog, VideoRow  # noqa: F401
from .discover import VideoMeta, FakeSearcher, YtDlpSearcher, Searcher  # noqa: F401
from .prescreen import prescreen  # noqa: F401
from .score import predict_yield  # noqa: F401
from .scout import Scout  # noqa: F401
