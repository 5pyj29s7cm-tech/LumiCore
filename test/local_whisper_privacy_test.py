"""Offline Whisper checks using synthetic files and a fake model; no AI runtime."""
import builtins
import contextlib
import io
import os
from pathlib import Path
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "server" / "stt" / "local_whisper.py"


class LocalWhisperPrivacyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lumi_whisper_privacy_")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {
            "LUMI_PRIVACY": "strict", "WHISPER_MODEL_DIR": str(self.root),
            "LUMI_WHISPER_MODEL": "small", "LUMI_WHISPER_DEVICE": "cuda",
            "LUMI_WHISPER_ALLOW_HIGH_ACCURACY_DOWNLOAD": "1",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.module = runpy.run_path(str(SCRIPT), run_name="privacy_test_module")

    def cache_model(self):
        snapshot = self.root / "models--Systran--faster-whisper-small" / "snapshots" / "test"
        snapshot.mkdir(parents=True)
        for name in ("model.bin", "config.json"):
            (snapshot / name).write_bytes(b"synthetic")

    def test_missing_dependency_never_runs_pip(self):
        original_import = builtins.__import__

        def synthetic_import(name, *args, **kwargs):
            if name == "faster_whisper":
                raise ImportError("Synthetic missing dependency")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=synthetic_import), patch("subprocess.check_call") as install:
            with self.assertRaisesRegex(RuntimeError, "automatic installation is disabled"):
                self.module["ensure_deps"]()
            install.assert_not_called()

    def test_uncached_small_model_cannot_download(self):
        self.assertTrue(self.module["should_skip_uncached_model"](str(self.root), "small"))
        self.cache_model()
        self.assertFalse(self.module["should_skip_uncached_model"](str(self.root), "small"))

    def test_gpu_fallback_keeps_model_loading_offline(self):
        self.cache_model()
        audio = self.root / "synthetic.wav"
        audio.write_bytes(b"synthetic")
        calls = []

        class FakeModel:
            def __init__(self, name, **kwargs):
                calls.append(kwargs)
                if kwargs["device"] == "cuda":
                    raise RuntimeError("Synthetic unavailable GPU")

            def transcribe(self, _audio, **kwargs):
                return [types.SimpleNamespace(text="synthetic transcript")], types.SimpleNamespace(language="zh", language_probability=1)

        fake_module = types.ModuleType("faster_whisper")
        fake_module.WhisperModel = FakeModel
        with patch.dict(sys.modules, {"faster_whisper": fake_module}), patch.object(sys, "argv", [str(SCRIPT), str(audio)]), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.module["main"]()
        self.assertEqual([call["device"] for call in calls], ["cuda", "cpu"])
        self.assertTrue(all(call["local_files_only"] is True for call in calls))
        self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")

    def test_probe_does_not_import_or_load_a_model(self):
        self.cache_model()
        with patch("importlib.util.find_spec", return_value=object()), patch.object(sys, "argv", [str(SCRIPT), "--check-available"]):
            with self.assertRaises(SystemExit) as result:
                self.module["main"]()
            self.assertEqual(result.exception.code, 0)

    def test_probe_requires_a_cached_model(self):
        with patch("importlib.util.find_spec", return_value=object()), patch.object(sys, "argv", [str(SCRIPT), "--check-available"]):
            with self.assertRaises(SystemExit) as result:
                self.module["main"]()
            self.assertEqual(result.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
