"""Download the voice models into bin/voice/models (data only, nothing executed)."""
import os, sys
from pathlib import Path
BIN = Path(__file__).resolve().parents[2] / "bin" / "voice"
os.environ.setdefault("HF_HOME", str(BIN / "hf"))
from huggingface_hub import snapshot_download

REPOS = {
    "voxcpm2": "openbmb/VoxCPM2",
    "moss": "OpenMOSS-Team/MOSS-TTS-Local-Transformer-v1.5",
    "whisper-he": "ivrit-ai/whisper-large-v3-turbo-ct2",
    "phonikud": "thewh1teagle/phonikud-onnx",
    "dictabert": "dicta-il/dictabert-large-char-menaked",
}
for name in (sys.argv[1:] or REPOS):
    p = snapshot_download(REPOS[name], local_dir=str(BIN / "models" / name))
    print("DONE", name, p, flush=True)
