from pathlib import Path
from unittest.mock import MagicMock, patch

from audiobook_worker.tts import (
    KokoroTTSBackend,
    MockTTSBackend,
    _kokoro_voice_for,
    _select_torch_device,
    voice_registry,
)


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


def test_voice_registry_has_kokoro_voices():
    voices = voice_registry()
    for voice_id, entry in voices.items():
        assert "kokoroVoice" in entry, f"{voice_id} missing kokoroVoice"
        assert isinstance(entry["kokoroVoice"], str), f"{voice_id} kokoroVoice not a string"
        assert len(entry["kokoroVoice"]) > 2, f"{voice_id} kokoroVoice too short"
        assert entry["backend"] == "kokoro", f"{voice_id} backend should be kokoro, got {entry['backend']}"


def test_voice_registry_backend_is_kokoro():
    voices = voice_registry()
    for voice_id, entry in voices.items():
        assert entry["backend"] == "kokoro", f"{voice_id} backend should be kokoro"


def test_kokoro_voice_for_maps_known_voices():
    assert _kokoro_voice_for("narrator_default") == "af_heart"
    assert _kokoro_voice_for("female_adult_01") == "af_heart"
    assert _kokoro_voice_for("male_adult_01") == "am_michael"
    assert _kokoro_voice_for("neutral_dialogue_01") == "af_nicole"


def test_kokoro_voice_for_falls_back_on_unknown_id():
    assert _kokoro_voice_for("nonexistent") == "af_heart"  # falls back to narrator_default


def test_voice_assignment_distributes_characters_across_pool():
    """Different characters of the same gender get different voices deterministically."""
    from audiobook_worker.script_builder import _voice_for_gender

    # Two female characters should (likely) get different voices
    voice_a = _voice_for_gender("female", "elizabeth")
    voice_b = _voice_for_gender("female", "jane")
    voice_c = _voice_for_gender("female", "lydia")

    # All should be in the female pool
    assert voice_a.startswith("female_adult_")
    assert voice_b.startswith("female_adult_")
    assert voice_c.startswith("female_adult_")

    # Same character always gets same voice (deterministic)
    assert _voice_for_gender("female", "elizabeth") == voice_a
    assert _voice_for_gender("female", "jane") == voice_b

    # Male voices
    voice_d = _voice_for_gender("male", "darcy")
    voice_e = _voice_for_gender("male", "bingley")
    assert voice_d.startswith("male_adult_")
    assert voice_e.startswith("male_adult_")


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


def test_kokoro_backend_synthesize_segment_produces_wav(tmp_path: Path):
    """KokoroTTSBackend.synthesize_segment writes a WAV and returns correct artifact."""
    import numpy as np
    import torch as _torch

    fake_audio = _torch.tensor(np.zeros(24000, dtype=np.float32))
    mock_result = MagicMock()
    mock_result.audio = fake_audio

    mock_pipeline = MagicMock()
    mock_pipeline.return_value = [mock_result]

    with patch("audiobook_worker.tts.KPipeline") as mock_kp:
        mock_kp.return_value = mock_pipeline

        backend = KokoroTTSBackend()

        segment = {
            "id": "seg_kokoro",
            "text": "It is a truth universally acknowledged.",
            "voiceId": "narrator_default",
            "emotion": "neutral",
        }
        artifact = backend.synthesize_segment(segment, tmp_path)

    assert artifact.kind == "segment_audio"
    assert artifact.path.suffix == ".wav"
    assert artifact.path.exists()
    assert artifact.duration_seconds > 0
