from pathlib import Path

from audiobook_worker.tts import MockTTSBackend, voice_registry


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

