"""FakeAdapter — the dependency-free placeholder generative adapter.

Future role (Stage 5 bring-up):
    The FakeAdapter is the *first* concrete ``GenerativeModelAdapter``. It returns
    deterministic placeholder audio so the entire generative orchestration — job
    submit/status/progress/cancel, the RenderLayer flow, cache fingerprinting, and
    the audition / A-B / accept-reject loop — can be proven end-to-end *before* the
    real StableAudio3Adapter (MLX, Apple Silicon only) is wired in. "FakeAdapter
    before SA3": prove the plumbing with the stub, swap the real model in last.

    Being deterministic and stdlib-only, it also runs in CI and on machines without
    the heavy SA3/MLX stack — which is why this whole service carries ZERO external
    Python dependencies at Stage 0.

Stage 0 scope (this file):
    Class skeleton + capability reporting only. NO audio generation yet.

# VERIFY: The real job protocol is NOT implemented here. The submit/status/
# progress/cancel request shapes and the warmup / heartbeat / crash-restart /
# cancel-on-close lifecycle are specified in module 05
# (05_GENERATIVE_LAYER.md) and get implemented in Stage 5. When that lands,
# FakeAdapter gains: generate(...), reimagine(...), and the file+manifest audio
# handoff — all keyed by the full cache fingerprint (05 §5). Do not add them
# before resolving the protocol against module 05.
"""


class FakeAdapter:
    """Deterministic placeholder generative adapter (Stage-0 skeleton).

    Exposes only ``name`` and ``health()`` for now. Audio generation and the job
    lifecycle arrive in Stage 5 (see the module-level ``# VERIFY`` note).
    """

    #: Adapter identifier surfaced by /health and /capabilities.
    name = "fake"

    def health(self) -> dict:
        """Return the capability block advertised to the C++ Generative Job Manager.

        Stage 0: a static declaration of what this adapter *will* support. The
        flags are wired to real code paths in Stage 5.
        """
        return {
            "generate": True,
            "reimagine": True,
        }
