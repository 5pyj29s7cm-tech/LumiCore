# local_whisper.py — faster-whisper STT for LumiCore
# Usage: python local_whisper.py <audio_file_path> [language]
# Output: transcribed text to stdout
#
# First run auto-installs faster-whisper if not present.
# Model (~500MB) caches to $WHISPER_MODEL_DIR or ../data/whisper_models/

import os, sys, subprocess, json, site, inspect

MODEL_PLAN = [item.strip() for item in os.environ.get("LUMI_WHISPER_MODEL", "large-v3,medium,small").split(",") if item.strip()]
DEVICE = os.environ.get("LUMI_WHISPER_DEVICE", "cpu").lower()
COMPUTE_TYPE = os.environ.get("LUMI_WHISPER_COMPUTE_TYPE", "int8").lower()
BEAM_SIZE = int(os.environ.get("LUMI_WHISPER_BEAM_SIZE", "5"))
VAD_FILTER = os.environ.get("LUMI_WHISPER_VAD", "1") != "0"
ALLOW_HIGH_ACCURACY_DOWNLOAD = os.environ.get("LUMI_WHISPER_ALLOW_HIGH_ACCURACY_DOWNLOAD", "0") == "1"
INITIAL_PROMPT = os.environ.get(
    "LUMI_WHISPER_INITIAL_PROMPT",
    "以下是中文普通话会议、电话录音或法律咨询内容，请准确转写人名、金额、日期、合同、款项、诉讼、法院、律师等关键词，保留自然标点。"
)
HOTWORDS = os.environ.get(
    "LUMI_WHISPER_HOTWORDS",
    "合同 协议 款项 汇款 转账 金额 保证金 项目 合作 诉讼 起诉 立案 开庭 法院 法官 律师 证据 材料 财务 征信"
).strip()

def ensure_deps():
    try:
        from faster_whisper import WhisperModel
        return WhisperModel
    except ImportError:
        print("[local_whisper] Installing faster-whisper (one-time)...", file=sys.stderr)
        subprocess.check_call([sys.executable, "-m", "pip", "install", "faster-whisper", "-q"])
        print("[local_whisper] Done.", file=sys.stderr)
        from faster_whisper import WhisperModel
        return WhisperModel

def model_cache_slug(model_name):
    if "/" in model_name or "\\" in model_name:
        return None
    return f"models--Systran--faster-whisper-{model_name}"

def model_cache_min_bytes(model_name):
    name = model_name.lower()
    if "large" in name:
        return 2_500_000_000
    if "medium" in name:
        return 1_200_000_000
    if "small" in name:
        return 400_000_000
    if "base" in name:
        return 120_000_000
    return 0

def model_cached(model_dir, model_name):
    slug = model_cache_slug(model_name)
    if not slug:
        return True
    blob_dir = os.path.join(model_dir, slug, "blobs")
    if not os.path.isdir(blob_dir):
        return False
    total = 0
    for root, _dirs, files in os.walk(blob_dir):
        for file in files:
            try:
                total += os.path.getsize(os.path.join(root, file))
            except OSError:
                pass
    return total >= model_cache_min_bytes(model_name)

def should_skip_uncached_model(model_dir, model_name):
    name = model_name.lower()
    if model_cached(model_dir, model_name):
        return False
    if name in ("tiny", "base", "small"):
        return False
    return not ALLOW_HIGH_ACCURACY_DOWNLOAD

def main():
    if len(sys.argv) < 2:
        print("Usage: python local_whisper.py <wav_file>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "zh"
    if not os.path.exists(audio_path):
        print(f"File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    WhisperModel = ensure_deps()

    # Model cache directory — prefer project data dir
    model_dir = os.environ.get("WHISPER_MODEL_DIR", "")
    if not model_dir:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        project_data = os.path.join(script_dir, "..", "..", "data", "whisper_models")
        model_dir = os.path.abspath(project_data)
    os.makedirs(model_dir, exist_ok=True)

    requested_device = DEVICE
    if requested_device == "auto":
        requested_device = "cuda"
    requested_compute = COMPUTE_TYPE
    if requested_compute == "auto":
        requested_compute = "float16" if requested_device == "cuda" else "int8"

    errors = []
    segments = None
    info = None
    used_model = None
    for model_name in MODEL_PLAN:
        if should_skip_uncached_model(model_dir, model_name):
            print(f"[local_whisper] Skipping uncached high-accuracy model '{model_name}'. Set LUMI_WHISPER_ALLOW_HIGH_ACCURACY_DOWNLOAD=1 to download it.", file=sys.stderr)
            continue
        print(f"[local_whisper] Loading model '{model_name}' ({requested_device}/{requested_compute}) from {model_dir}...", file=sys.stderr)
        try:
            try:
                model = WhisperModel(model_name, device=requested_device, compute_type=requested_compute, download_root=model_dir)
            except Exception as exc:
                if requested_device != "cuda":
                    raise
                print(f"[local_whisper] CUDA unavailable or incompatible ({exc}); falling back to CPU/int8.", file=sys.stderr)
                model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=model_dir)
            transcribe_kwargs = {
                "language": language,
                "beam_size": BEAM_SIZE,
                "vad_filter": VAD_FILTER,
                "vad_parameters": {"min_silence_duration_ms": 500},
                "initial_prompt": INITIAL_PROMPT,
                "condition_on_previous_text": False,
            }
            try:
                if HOTWORDS and "hotwords" in inspect.signature(model.transcribe).parameters:
                    transcribe_kwargs["hotwords"] = HOTWORDS
            except (TypeError, ValueError):
                pass
            segments, info = model.transcribe(audio_path, **transcribe_kwargs)
            used_model = model_name
            break
        except Exception as exc:
            errors.append(f"{model_name}: {exc}")
            print(f"[local_whisper] Model '{model_name}' failed: {exc}", file=sys.stderr)
    if segments is None or info is None:
        print("[local_whisper] All model attempts failed: " + "; ".join(errors), file=sys.stderr)
        sys.exit(2)
    detected = info.language
    print(f"[local_whisper] Used model: {used_model}", file=sys.stderr)
    print(f"[local_whisper] Detected language: {detected} (prob {info.language_probability:.3f})", file=sys.stderr)

    text = "".join(seg.text for seg in segments).strip()
    print(text)

if __name__ == "__main__":
    main()
