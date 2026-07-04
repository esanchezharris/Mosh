# SoulX on the owner's PC — bring-up runbook (FMS Phase-3 Stage 3)

*Owner decision 2026-07-04: renders run on the PC (Windows + NVIDIA) over SSH — voice
data never leaves your own hardware, $0/render, no spin-up. RunPod batch spin-up
(`scripts/fms-killshot/remote/runpod_ksa.sh`, the KS-A-proven shape) stays the fallback
when the PC is off. This is the ONE-TIME setup; after it, Mosh's sing renders switch
from guide beeps to your own voice automatically.*

**Everything here is owner-gated** — the Mac side ships working today with the fake
legato-beep backend and needs none of this.

## 1. PC: environment (WSL2 recommended)

Use **WSL2 + Ubuntu** on the PC (CUDA-in-WSL2 is mature, and the automation speaks
POSIX — the KS-A commands below are exactly the ones proven on the RunPod Linux pod).
Native-Windows conda works too (see `scripts/fms-killshot/KSA_RUNBOOK_WINDOWS.md`) but
the SSH runner assumes a POSIX shell.

```bash
# In WSL2, with the NVIDIA driver installed on Windows (nvidia-smi works in WSL):
mkdir -p ~/mosh-soulx && cd ~/mosh-soulx
git clone https://github.com/Soul-AILab/SoulX-Singer.git
python3.10 -m venv env       # or conda create -p ./env python=3.10
./env/bin/pip install -r SoulX-Singer/requirements.txt   # torch 2.2 pins — KS-A gotcha:
                                                          # use cu124 wheels on a cu12.4
                                                          # driver (cu130 sees NO GPU)
# Weights (Apache-2.0, ~12 GB VRAM to run):
./env/bin/pip install "huggingface_hub[cli]"
./env/bin/huggingface-cli download Soul-AILab/SoulX-Singer \
    --local-dir SoulX-Singer/pretrained_models/SoulX-Singer
```

Smoke (their bundled example — the KS-A install check):

```bash
cd ~/mosh-soulx/SoulX-Singer
PYTHONPATH=. ../env/bin/python -m cli.inference --device cuda \
  --model_path pretrained_models/SoulX-Singer/model.pt \
  --config soulxsinger/config/soulxsinger.yaml \
  --prompt_wav_path example/audio/zh_prompt.mp3 \
  --prompt_metadata_path example/audio/zh_prompt.json \
  --target_metadata_path example/audio/en_target.json \
  --phoneset_path soulxsinger/utils/phoneme/phone_set.json \
  --control score --auto_shift --pitch_shift 0 --fp16 --save_dir /tmp/smoke
```

## 2. PC: SSH server

WSL2: `sudo apt install openssh-server`, set a port in `/etc/ssh/sshd_config` (e.g.
2222), forward it from Windows (`netsh interface portproxy …` or the WSL settings UI),
and put your Mac's `~/.ssh/id_ed25519.pub` in `~/.ssh/authorized_keys`. Then on the Mac,
an alias in `~/.ssh/config`:

```
Host gamer-pc
  HostName <pc-lan-ip>
  Port 2222
  User <wsl-user>
```

`ssh gamer-pc nvidia-smi` must work non-interactively (BatchMode).

## 3. Enrollment (one-time, the consent wall)

v0 is **locked-to-self**: ONE enrolled voice per install — yours. Pick a clean 10–30 s
sung reference (KS-A: "sounds exactly like me" held from the 10-second slice).

The reference must itself be transcribed once (SoulX conditions on what the prompt
sings). On the PC — this needs the DEDICATED preprocess env (`env-pre`), because NeMo's
pins are incompatible with the inference env (the KS-A lesson):

```bash
cd ~/mosh-soulx
python3.10 -m venv env-pre
./env-pre/bin/pip install -r SoulX-Singer/requirements.txt
./env-pre/bin/pip install -U "nemo_toolkit[asr]"
./env-pre/bin/python -c "import nltk; nltk.download('averaged_perceptron_tagger_eng')"
# then run their preprocess on your reference.wav -> reference.json
# (SoulX-Singer/preprocess — Mel-RoFormer + RMVPE + Parakeet ASR + ROSVOT)
```

Copy BOTH files to the Mac:

```
~/Library/Mosh/voice/reference.wav
~/Library/Mosh/voice/reference.json
```

## 4. Mac: switch the backend on

```bash
launchctl setenv MOSH_SOULX_SSH_HOST gamer-pc     # or export it where Mosh launches
```

That's the whole switch: `soulx_adapter.available()` = host set + reference present.
Next sing render ships `target_score.json` + the reference to the PC
(`service/soulx/pc_render.sh`), pulls the WAV back, and **removes the remote job dir**
— nothing accumulates on the PC beyond the enrollment. `MOSH_ENABLE_SOULX=0` force-pins
the fake (that's what `--selftest` does).

Verify end-to-end: render any sing layer; the drawer's manifest line should read
`backend: soulx-pc` instead of the `placeholder_vocal` flag.

## Ship gates (logged, not optional)

- **Watermarking** the rendered vocal is a ship-gate before any public release of this
  feature (decision logged in the Phase-3 build plan; not implemented in v0).
- **SVC mode stays parked** until its 2×-length/clipping bug is understood (KS-A r7
  "demonic").
