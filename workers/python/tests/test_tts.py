from pathlib import Path
from unittest.mock import MagicMock, patch

from audiobook_worker.tts import MockTTSBackend, _select_torch_device, voice_registry


def test_select_torch_device_prefers_mps_when_available():
    class FakeTorch:
        class backends:
            class mps:
                @staticmethod
                def is_available():
                    return True

        class cuda:
            @staticmethod
            def is_available():
                return True

    assert _select_torch_device(FakeTorch, "auto") == "mps"


def test_select_torch_device_errors_when_requested_gpu_is_unavailable():
    class FakeTorch:
        class backends:
            class mps:
                @staticmethod
                def is_available():
                    return False

        class cuda:
            @staticmethod
            def is_available():
                return False

    try:
        _select_torch_device(FakeTorch, "mps")
    except RuntimeError as error:
        assert "MPS was requested" in str(error)
    else:
        raise AssertionError("expected RuntimeError")


def test_mock_backend_generates_segment_audio_artifact(tmp_path: Path):
    backend = MockTTSBackend()
    segment = {
        "id": "seg_0001",
        "text": "Hello world.",
        "voiceId": "narrator_default",
        "emotion": "neutral",
    }

    artifact = backend.synthesize_segment(segment, tmp_path)

    assert artifact.kind == "segment_audio"
    assert artifact.path.exists()
    assert artifact.path.suffix == ".wav"


def test_voice_registry_declares_language_and_license_metadata():
    voices = voice_registry()

    narrator = voices["narrator_default"]
    assert narrator["languages"] == ["en"]
    assert "licenseNotes" in narrator


def test_voice_registry_has_parler_descriptions():
    voices = voice_registry()
    for voice_id, entry in voices.items():
        assert "parlerDescription" in entry, f"{voice_id} missing parlerDescription"
        assert len(entry["parlerDescription"]) > 20, f"{voice_id} description too short"


def test_parler_backend_synthesize_segment_produces_wav(tmp_path: Path):
    """ParlerTTSBackend.synthesize_segment writes a WAV and returns correct artifact."""
    import numpy as np

    fake_audio = np.zeros(24000, dtype=np.float32)

    mock_model = MagicMock()
    mock_model.config.sampling_rate = 24000
    mock_model.to.return_value = mock_model  # .to(device) returns itself
    mock_model.generate.return_value = MagicMock(
        cpu=lambda: MagicMock(numpy=lambda: fake_audio.reshape(1, -1))
    )
    mock_tokenizer = MagicMock()
    mock_tokenizer.return_value = MagicMock(input_ids=MagicMock())

    with patch("audiobook_worker.tts.ParlerTTSForConditionalGeneration") as mock_cls, \
         patch("audiobook_worker.tts.AutoTokenizer") as mock_tok_cls:
        mock_cls.from_pretrained.return_value = mock_model
        mock_tok_cls.from_pretrained.return_value = mock_tokenizer

        from audiobook_worker.tts import ParlerTTSBackend
        backend = ParlerTTSBackend()

        segment = {
            "id": "seg_0001",
            "text": "It was a dark and stormy night.",
            "voiceId": "narrator_default",
            "emotion": "neutral",
            "intensity": 0.2,
            "pace": "normal",
        }
        artifact = backend.synthesize_segment(segment, tmp_path)

    assert artifact.kind == "segment_audio"
    assert artifact.path.suffix == ".wav"
    assert artifact.path.exists()
    assert artifact.duration_seconds > 0


def test_parler_backend_builds_description_with_emotion(tmp_path: Path):
    """Emotion modifiers are appended to the base voice description."""
    import numpy as np

    fake_audio = np.zeros(24000, dtype=np.float32)
    mock_model = MagicMock()
    mock_model.config.sampling_rate = 24000
    mock_model.to.return_value = mock_model
    mock_model.generate.return_value = MagicMock(
        cpu=lambda: MagicMock(numpy=lambda: fake_audio.reshape(1, -1))
    )
    mock_tokenizer = MagicMock()
    mock_tokenizer.return_value = MagicMock(input_ids=MagicMock())

    with patch("audiobook_worker.tts.ParlerTTSForConditionalGeneration") as mock_cls, \
         patch("audiobook_worker.tts.AutoTokenizer") as mock_tok_cls:
        mock_cls.from_pretrained.return_value = mock_model
        mock_tok_cls.from_pretrained.return_value = mock_tokenizer

        from audiobook_worker.tts import ParlerTTSBackend
        backend = ParlerTTSBackend()

        segment = {
            "id": "seg_0002",
            "text": "Get out of my house!",
            "voiceId": "male_adult_01",
            "emotion": "angry",
            "intensity": 0.7,
            "pace": "fast",
        }
        backend.synthesize_segment(segment, tmp_path)

    first_call_args = mock_tokenizer.call_args_list[0][0][0]
    assert "angry" in first_call_args.lower() or "forceful" in first_call_args.lower()
