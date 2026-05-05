import json
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

