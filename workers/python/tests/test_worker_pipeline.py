import json
import os
import subprocess
import sys
from pathlib import Path


def run_worker(command: str, input_payload: dict, tmp_path: Path) -> dict:
    input_path = tmp_path / f"{command}.input.json"
    output_path = tmp_path / f"{command}.output.json"
    input_path.write_text(json.dumps(input_payload), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-m", "audiobook_worker.cli", command, str(input_path), str(output_path)],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "AUDIOBOOK_LLM_MODEL": "mock"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(output_path.read_text(encoding="utf-8"))


def test_generates_script_segment_audio_and_chapter_audio(tmp_path: Path):
    chapter_path = tmp_path / "chapter_001.txt"
    chapter_path.write_text('She waited. "Come in," Elizabeth said.', encoding="utf-8")
    script_dir = tmp_path / "scripts"

    analyze = run_worker(
        "analyze_chapter",
        {
            "bookId": "book_123",
            "chapterId": "chapter_001",
            "title": "Chapter 1",
            "language": "en",
            "chapterTextPath": str(chapter_path),
            "outputDirectory": str(script_dir),
        },
        tmp_path,
    )

    assert analyze["status"] == "succeeded"
    script_path = Path(analyze["artifacts"][0]["path"])
    script = json.loads(script_path.read_text(encoding="utf-8"))
    assert script["segments"][1]["speakerId"] == "elizabeth"

    segment_dir = tmp_path / "segments"
    for segment in script["segments"]:
        synthesize = run_worker(
            "synthesize_segment_audio",
            {
                "bookId": "book_123",
                "chapterId": "chapter_001",
                "segmentId": segment["id"],
                "scriptPath": str(script_path),
                "outputDirectory": str(segment_dir),
                "backend": "mock",
            },
            tmp_path,
        )
        assert synthesize["status"] == "succeeded"

    assemble = run_worker(
        "assemble_chapter_audio",
        {
            "bookId": "book_123",
            "chapterId": "chapter_001",
            "segmentAudioDirectory": str(segment_dir),
            "outputPath": str(tmp_path / "chapter_001.wav"),
        },
        tmp_path,
    )

    assert assemble["status"] == "succeeded"
    assert Path(assemble["artifacts"][0]["path"]).exists()


def test_corrections_flow_applies_alias_merge_and_regenerates(tmp_path: Path):
    chapter_path = tmp_path / "chapter_001.txt"
    chapter_path.write_text('"Over here," Lizzy called. "Coming," Elizabeth replied.', encoding="utf-8")
    script_dir = tmp_path / "scripts"
    script_dir.mkdir()

    # Step 1: Run initial analysis
    analyze = run_worker(
        "analyze_chapter",
        {
            "bookId": "book_123",
            "chapterId": "chapter_001",
            "title": "Chapter 1",
            "language": "en",
            "chapterTextPath": str(chapter_path),
            "outputDirectory": str(script_dir),
        },
        tmp_path,
    )
    assert analyze["status"] == "succeeded"

    # Step 2: Apply alias merge correction
    corrections = run_worker(
        "apply_corrections",
        {
            "bookId": "book_123",
            "chapters": [
                {"chapterId": "chapter_001", "textPath": str(chapter_path), "title": "Chapter 1"}
            ],
            "corrections": {
                "aliasMerges": [{"from": "Lizzy", "to": "Elizabeth"}],
                "genderOverrides": [],
                "voiceOverrides": [],
            },
            "outputDirectory": str(script_dir),
            "language": "en",
        },
        tmp_path,
    )
    assert corrections["status"] == "succeeded"
    corrected_path = Path(corrections["artifacts"][0]["path"])
    corrected_script = json.loads(corrected_path.read_text())

    # Speakers should be unified to elizabeth only
    speakers = {seg["speakerId"] for seg in corrected_script["segments"] if seg["type"] == "dialogue"}
    assert speakers == {"elizabeth"}

    # Characters should have only one elizabeth entry
    character_ids = {c["id"] for c in corrected_script["characters"]}
    assert "elizabeth" in character_ids
    assert "lizzy" not in character_ids
