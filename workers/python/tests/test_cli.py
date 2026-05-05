import json
import subprocess
import sys
from pathlib import Path


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

