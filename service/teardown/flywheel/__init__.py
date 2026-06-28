"""§11 Training flywheel + §12 RL bridge — reward PRODUCTION and the interface.

The escape from circularity is the anchor corpus (only `deterministic` reconstructions are
gold) + the ablation engine: controlled edits that change ONE musical decision while holding
the production surface roughly constant → graded triplets with a KNOWN ordering the reward
must preserve. That ordering-preservation (beating raw CLAP) is the keystone result, and the
reward head it trains drops straight into §6's scorer and §12's "pull" slot.

This module ships the verifiable cores (anchor store, ablation engine, a triplet-trained
reward head on a stand-in encoder, and the versioned Reward/PromptFeed interface the GRPO
loop imports). The REAL reward needs real anchors (from §9-execute) + a music encoder
(MuQ/MERT) — gated, like SA3.
"""
from .anchors import Anchor, AnchorStore  # noqa: F401
from .ablate import AblationEngine, Triplet  # noqa: F401
from .train_sim import ordering_accuracy, train_reward_head  # noqa: F401
from .reward import PromptFeed, Reward  # noqa: F401
