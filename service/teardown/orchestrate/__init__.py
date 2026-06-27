"""§10 Orchestration — the conductor. A staged, confidence-gated pipeline (not a magic
end-to-end agent) that drives one video (or a §3-queue batch) through §4 → §7 → §1 → §9,
checkpointing the Recipe at every step (resumable from the last checkpoint). Stages are
injectable, so the conductor is hermetically testable with fakes and runs the real stages
in production. Agentic decisions (labeling/section-naming/substitute choice) use a heuristic
by default, with an optional LLM enhancer; the LLM proposes, the schema disposes.
"""
from .policy import Policy  # noqa: F401
from .pipeline import Orchestrator, RunResult, Stage  # noqa: F401
