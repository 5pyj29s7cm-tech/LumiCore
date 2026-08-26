# Voiceprint Provider

LumiCore uses a provider chain for voiceprint verification:

1. `speechbrain-ecapa` when Python dependencies and the model are available.
2. Local MFCC verification as a fallback for offline or uninstalled environments.

Install the mature provider:

```powershell
python -m pip install -r server/biometrics/requirements-voiceprint.txt
```

Default model:

- `speechbrain/spkrec-ecapa-voxceleb`
- Cached under `data/voiceprint_models` unless `LUMI_VOICEPRINT_MODEL_DIR` is set.

Useful environment variables:

- `LUMI_VOICEPRINT_PROVIDER=speechbrain` enables SpeechBrain first, then MFCC fallback.
- `LUMI_VOICEPRINT_PROVIDER=mfcc` disables SpeechBrain and only uses local MFCC.
- `LUMI_VOICEPRINT_PYTHON=python` selects the Python executable.
- `LUMI_VOICEPRINT_MODEL=speechbrain/spkrec-ecapa-voxceleb` overrides the model source.
- `LUMI_VOICEPRINT_DEVICE=cpu` can be changed to `cuda` on GPU hosts.

The sidecar stores speaker embeddings, not raw enrollment audio.
