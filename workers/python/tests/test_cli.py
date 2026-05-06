import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch


def run_worker(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "audiobook_worker.cli", *args],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
        capture_output=True,
        check=False,
    )


def test_help_prints_usage():
    result = run_worker("--help")

    assert result.returncode == 0
    assert "usage:" in result.stdout
    assert "command" in result.stdout


def test_unknown_command_returns_structured_error(tmp_path: Path):
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text("{}", encoding="utf-8")

    result = run_worker("unknown_command", str(input_path), str(output_path))

    assert result.returncode == 2
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload == {
        "status": "failed",
        "warnings": [],
        "artifacts": [],
        "error": {
            "code": "unknown_command",
            "message": "Unknown worker command: unknown_command",
        },
    }


def test_synthesize_segment_audio_uses_parler_backend(tmp_path: Path):
    """CLI synthesize_segment_audio command selects ParlerTTSBackend when backend=parler."""
    import numpy as np
    from audiobook_worker.cli import main

    script = {
        "bookId": "book1",
        "chapterId": "ch01",
        "segments": [
            {
                "id": "seg_0001",
                "text": "In the beginning.",
                "voiceId": "narrator_default",
                "emotion": "neutral",
                "intensity": 0.2,
                "pace": "normal",
            }
        ],
    }
    script_path = tmp_path / "script.json"
    script_path.write_text(json.dumps(script))

    request = {
        "scriptPath": str(script_path),
        "segmentId": "seg_0001",
        "outputDirectory": str(tmp_path / "audio"),
        "backend": "parler",
    }
    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps(request))
    output_path = tmp_path / "output.json"

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

        exit_code = main(["synthesize_segment_audio", str(input_path), str(output_path)])

    assert exit_code == 0
    result = json.loads(output_path.read_text())
    assert result["status"] == "succeeded"
    # Verify Parler model was actually loaded, not the mock backend
    mock_cls.from_pretrained.assert_called_once()


def test_synthesize_chapter_audio_merges_adjacent_compatible_segments_and_cleans_stale_audio(tmp_path: Path):
    from audiobook_worker.cli import main

    script = {
        "bookId": "book1",
        "chapterId": "ch01",
        "segments": [
            {"id": "seg_0001", "text": "Hello", "voiceId": "narrator_default", "emotion": "neutral", "pace": "normal"},
            {"id": "seg_0002", "text": "there.", "voiceId": "narrator_default", "emotion": "neutral", "pace": "normal"},
            {"id": "seg_0003", "text": "Stop.", "voiceId": "male_adult_01", "emotion": "angry", "pace": "fast"},
        ],
    }
    script_path = tmp_path / "script.json"
    script_path.write_text(json.dumps(script), encoding="utf-8")
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    (audio_dir / "stale.wav").write_bytes(b"old")

    request = {
        "scriptPath": str(script_path),
        "outputDirectory": str(audio_dir),
        "backend": "mock",
        "mergeSegments": True,
    }
    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps(request), encoding="utf-8")
    output_path = tmp_path / "output.json"

    exit_code = main(["synthesize_chapter_audio", str(input_path), str(output_path)])

    assert exit_code == 0
    result = json.loads(output_path.read_text())
    assert result["status"] == "succeeded"
    assert result["metadata"] == {
        "originalSegmentCount": 3,
        "synthesizedSegmentCount": 2,
    }
    assert len(result["artifacts"]) == 2
    assert result["artifacts"][0]["metadata"]["sourceSegmentIds"] == ["seg_0001", "seg_0002"]
    assert not (audio_dir / "stale.wav").exists()


def test_apply_corrections_command(tmp_path: Path):
    from audiobook_worker.cli import main

    chapter_path = tmp_path / "ch01.txt"
    chapter_path.write_text('"Hello," said Lizzy. "Hi," Elizabeth replied.', encoding="utf-8")
    output_dir = tmp_path / "scripts"
    output_dir.mkdir()

    request = {
        "bookId": "book1",
        "chapters": [
            {"chapterId": "ch01", "textPath": str(chapter_path), "title": "Chapter 1"}
        ],
        "corrections": {
            "aliasMerges": [{"from": "Lizzy", "to": "Elizabeth"}],
            "genderOverrides": [{"characterId": "elizabeth", "gender": "female"}],
            "voiceOverrides": [],
        },
        "outputDirectory": str(output_dir),
        "language": "en",
    }
    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps(request), encoding="utf-8")
    output_path = tmp_path / "output.json"

    with patch.dict(os.environ, {"AUDIOBOOK_LLM_MODEL": "mock"}):
        exit_code = main(["apply_corrections", str(input_path), str(output_path)])

    assert exit_code == 0
    result = json.loads(output_path.read_text())
    assert result["status"] == "succeeded"
    assert len(result["artifacts"]) == 1
    assert result["artifacts"][0]["kind"] == "chapter_script"

    # verify alias merge was applied
    script = json.loads(Path(result["artifacts"][0]["path"]).read_text())
    speakers = {seg["speakerId"] for seg in script["segments"] if seg["type"] == "dialogue"}
    assert speakers == {"elizabeth"}


def test_read_file_command(tmp_path: Path):
    from audiobook_worker.cli import main

    data = {"key": "value", "nested": [1, 2]}
    file_path = tmp_path / "test.json"
    file_path.write_text(json.dumps(data), encoding="utf-8")

    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps({"path": str(file_path)}), encoding="utf-8")
    output_path = tmp_path / "output.json"

    exit_code = main(["_read_file", str(input_path), str(output_path)])

    assert exit_code == 0
    result = json.loads(output_path.read_text())
    assert result == data


def test_check_rights_classifies_allowed_public_domain(tmp_path: Path):
    from audiobook_worker.cli import main

    book_path = tmp_path / "test.txt"
    book_path.write_text("Project Gutenberg public domain work", encoding="utf-8")

    request = {
        "bookPath": str(book_path),
        "metadata": {"title": "Test Book"},
    }
    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps(request), encoding="utf-8")
    output_path = tmp_path / "output.json"

    exit_code = main(["check_rights", str(input_path), str(output_path)])

    assert exit_code == 0
    result = json.loads(output_path.read_text())
    assert result["status"] == "succeeded"
    assert result["classification"] == "allowed"
    assert result["reason"] == "public_domain_notice"
    assert result["requiresAttestation"] == False
    assert result["evidence"] == ["public_domain_notice"]


def test_check_rights_classifies_blocked_drm(tmp_path: Path):
    from audiobook_worker.cli import main

    request = {
        "bookPath": str(tmp_path / "nonexistent.txt"),
        "metadata": {"drm": True},
    }
    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps(request), encoding="utf-8")
    output_path = tmp_path / "output.json"

    exit_code = main(["check_rights", str(input_path), str(output_path)])

    assert exit_code == 0
    result = json.loads(output_path.read_text())
    assert result["classification"] == "blocked"
    assert result["reason"] == "drm_detected"
