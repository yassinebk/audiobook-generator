from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from audiobook_worker.audio import assemble_chapter_audio
from audiobook_worker.llm import MockLLMAnalyzer, default_analyzer
from audiobook_worker.segment_merge import merge_tts_segments
from audiobook_worker.script_builder import build_chapter_script, build_chapter_script_with_corrections
from audiobook_worker.tts import KokoroTTSBackend, MockTTSBackend, ParlerTTSBackend


def _response(
    status: str,
    *,
    warnings: list[str] | None = None,
    artifacts: list[dict[str, Any]] | None = None,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": status,
        "warnings": warnings or [],
        "artifacts": artifacts or [],
    }
    if error is not None:
        payload["error"] = error
    return payload


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _segment_cache_signature(segment: dict[str, Any], backend_name: str, model_id: str | None) -> str:
    payload = {
        "backend": backend_name,
        "modelId": model_id or "default",
        "text": segment.get("text", ""),
        "voiceId": segment.get("voiceId", "narrator_default"),
        "emotion": segment.get("emotion", "neutral"),
        "intensity": segment.get("intensity"),
        "pace": segment.get("pace", "normal"),
        "sourceSegmentIds": segment.get("sourceSegmentIds", [segment["id"]]),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _segment_cache_metadata_path(audio_path: Path) -> Path:
    return audio_path.with_suffix(audio_path.suffix + ".json")


def _read_cached_segment_artifact(
    segment: dict[str, Any],
    output_directory: Path,
    expected_signature: str,
) -> dict[str, Any] | None:
    audio_path = output_directory / f"{segment['id']}.wav"
    metadata_path = _segment_cache_metadata_path(audio_path)
    if not audio_path.exists() or not metadata_path.exists():
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if metadata.get("signature") != expected_signature:
        return None
    return {
        "kind": "segment_audio",
        "path": str(audio_path),
        "metadata": {
            "durationSeconds": metadata.get("durationSeconds", 0),
            "device": metadata.get("device"),
            "sourceSegmentIds": metadata.get("sourceSegmentIds", segment.get("sourceSegmentIds", [segment["id"]])),
            "cacheHit": True,
        },
    }


def _write_segment_cache_metadata(
    audio_path: Path,
    *,
    signature: str,
    duration_seconds: float,
    backend_name: str,
    model_id: str | None,
    device: str | None,
    source_segment_ids: list[str],
) -> None:
    _write_json(
        _segment_cache_metadata_path(audio_path),
        {
            "signature": signature,
            "backend": backend_name,
            "modelId": model_id or "default",
            "durationSeconds": duration_seconds,
            "device": device,
            "sourceSegmentIds": source_segment_ids,
        },
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="audiobook-worker",
        description="Run local audiobook processing worker commands.",
    )
    parser.add_argument("command", nargs="?", help="worker command to run")
    parser.add_argument("input_path", nargs="?", help="path to JSON worker input")
    parser.add_argument("output_path", nargs="?", help="path to write JSON worker output")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    if args.input_path is None or args.output_path is None:
        parser.error("command requires input_path and output_path")

    input_path = Path(args.input_path)
    output_path = Path(args.output_path)
    request = json.loads(input_path.read_text(encoding="utf-8"))
    try:
        payload = _dispatch(args.command, request)
        _write_json(output_path, payload)
        if payload.get("error", {}).get("code") == "unknown_command":
            return 2
        return 0 if payload.get("status") != "failed" else 1
    except KeyError as error:
        payload = _response(
            "failed",
            error={
                "code": "invalid_worker_input",
                "message": f"Missing required worker input field: {error.args[0]}",
            },
        )
        _write_json(output_path, payload)
        return 1



def _dispatch(command: str, request: dict[str, Any]) -> dict[str, Any]:
    handler = _dispatch_table.get(command)
    if handler is not None:
        return handler(request)
    return _response(
        "failed",
        error={
            "code": "unknown_command",
            "message": f"Unknown worker command: {command}",
        },
    )


def _extract_book(request: dict[str, Any]) -> dict[str, Any]:
    from audiobook_worker.chapters import detect_chapters
    from audiobook_worker.extract import extract_book_text
    from ebooklib import epub as epublib

    book_path = Path(request["bookPath"])
    title = book_path.stem
    if book_path.suffix.lower() == ".epub":
        try:
            book = epublib.read_epub(str(book_path))
            title_meta = book.get_metadata("DC", "title")
            if title_meta:
                title = title_meta[0][0]
        except Exception:
            pass

    result = extract_book_text(book_path)
    chapters = detect_chapters(result.text)

    output_dir = Path(request["outputDirectory"])
    output_dir.mkdir(parents=True, exist_ok=True)
    for chapter in chapters:
        (output_dir / f"{chapter.id}.txt").write_text(chapter.text, encoding="utf-8")

    return _response(
        "succeeded",
        warnings=result.warnings,
        artifacts=[
            {
                "kind": "book_extraction",
                "path": str(output_dir),
                "metadata": {
                    "title": title,
                    "chapterCount": len(chapters),
                    "chapters": [
                        {
                            "id": c.id,
                            "title": c.title,
                            "textLength": len(c.text),
                            "textPath": str(output_dir / f"{c.id}.txt"),
                        }
                        for c in chapters
                    ],
                    "requiresOcr": result.requires_ocr,
                },
            }
        ],
    )


def _analyze_chapter(request: dict[str, Any]) -> dict[str, Any]:
    chapter_text = Path(request["chapterTextPath"]).read_text(encoding="utf-8")
    output_directory = Path(request["outputDirectory"])
    output_directory.mkdir(parents=True, exist_ok=True)
    script = build_chapter_script(
        book_id=request["bookId"],
        chapter_id=request["chapterId"],
        title=request.get("title", request["chapterId"]),
        text=chapter_text,
        language=request.get("language", "en"),
        analyzer=MockLLMAnalyzer() if request.get("mockLlm") else default_analyzer(),
        known_characters=request.get("knownCharacters"),
    )
    script_path = output_directory / f"{request['chapterId']}.json"
    _write_json(script_path, script)
    return _response(
        "succeeded",
        artifacts=[{"kind": "chapter_script", "path": str(script_path)}],
    )


def _synthesize_segment_audio(request: dict[str, Any]) -> dict[str, Any]:
    script = json.loads(Path(request["scriptPath"]).read_text(encoding="utf-8"))
    segment = next(
        item for item in script["segments"] if item["id"] == request["segmentId"]
    )
    backend_name = request.get("backend", "kokoro")
    if backend_name == "parler":
        backend = ParlerTTSBackend()
    elif backend_name == "kokoro":
        backend = KokoroTTSBackend()
    else:
        backend = MockTTSBackend()
    artifact = backend.synthesize_segment(segment, Path(request["outputDirectory"]))
    return _response(
        "succeeded",
        artifacts=[
            {
                "kind": artifact.kind,
                "path": str(artifact.path),
                "metadata": {"durationSeconds": artifact.duration_seconds},
            }
        ],
    )


def _synthesize_chapter_audio(request: dict[str, Any]) -> dict[str, Any]:
    script = json.loads(Path(request["scriptPath"]).read_text(encoding="utf-8"))
    original_segments = script["segments"]
    if request.get("mergeSegments", True):
        segments = merge_tts_segments(
            original_segments,
            max_words=int(request.get("maxMergedSegmentWords", 200)),
        )
    else:
        segments = original_segments
    output_directory = Path(request["outputDirectory"])
    output_directory.mkdir(parents=True, exist_ok=True)
    backend_name = request.get("backend", "kokoro")
    model_id = request.get("modelId")
    cache_segments = request.get("cacheSegments", True)
    backend = None

    def get_backend():
        nonlocal backend
        if backend is None:
            if backend_name == "parler":
                backend = ParlerTTSBackend(model_id) if model_id else ParlerTTSBackend()
            elif backend_name == "kokoro":
                backend = KokoroTTSBackend()
            else:
                backend = MockTTSBackend()
        return backend

    artifacts = []
    expected_audio_paths = {output_directory / f"{segment['id']}.wav" for segment in segments}
    for segment in segments:
        signature = _segment_cache_signature(segment, backend_name, model_id)
        if cache_segments:
            cached_artifact = _read_cached_segment_artifact(
                segment,
                output_directory,
                signature,
            )
            if cached_artifact is not None:
                artifacts.append(cached_artifact)
                continue

        active_backend = get_backend()
        artifact = active_backend.synthesize_segment(segment, output_directory)
        device = getattr(active_backend, "_device", None)
        source_segment_ids = segment.get("sourceSegmentIds", [segment["id"]])
        if cache_segments:
            _write_segment_cache_metadata(
                artifact.path,
                signature=signature,
                duration_seconds=artifact.duration_seconds,
                backend_name=backend_name,
                model_id=model_id,
                device=device,
                source_segment_ids=source_segment_ids,
            )
        artifacts.append({
            "kind": artifact.kind,
            "path": str(artifact.path),
            "metadata": {
                "durationSeconds": artifact.duration_seconds,
                "device": device,
                "sourceSegmentIds": source_segment_ids,
                "cacheHit": False,
            },
        })
    for stale_audio in output_directory.glob("*.wav"):
        if stale_audio not in expected_audio_paths:
            stale_audio.unlink()
            stale_metadata = _segment_cache_metadata_path(stale_audio)
            if stale_metadata.exists():
                stale_metadata.unlink()
    payload = _response("succeeded", artifacts=artifacts)
    payload["metadata"] = {
        "originalSegmentCount": len(original_segments),
        "synthesizedSegmentCount": len(segments),
        "cachedSegmentCount": sum(1 for artifact in artifacts if artifact["metadata"].get("cacheHit")),
    }
    return payload


def _assemble_chapter_audio(request: dict[str, Any]) -> dict[str, Any]:
    segment_paths = sorted(Path(request["segmentAudioDirectory"]).glob("*.wav"))
    artifact = assemble_chapter_audio(segment_paths, Path(request["outputPath"]))
    return _response(
        "succeeded",
        artifacts=[
            {
                "kind": artifact.kind,
                "path": str(artifact.path),
                "metadata": {"durationSeconds": artifact.duration_seconds},
            }
        ],
    )


def _apply_corrections(request: dict[str, Any]) -> dict[str, Any]:
    output_directory = Path(request["outputDirectory"])
    output_directory.mkdir(parents=True, exist_ok=True)
    corrections = request.get("corrections", {})
    analyzer = MockLLMAnalyzer() if request.get("mockLlm") else default_analyzer()

    artifacts = []
    for chapter in request["chapters"]:
        chapter_text = Path(chapter["textPath"]).read_text(encoding="utf-8")
        script = build_chapter_script_with_corrections(
            book_id=request["bookId"],
            chapter_id=chapter["chapterId"],
            title=chapter.get("title", chapter["chapterId"]),
            text=chapter_text,
            language=request.get("language", "en"),
            corrections=corrections,
            analyzer=analyzer,
        )
        script_path = output_directory / f"{chapter['chapterId']}.json"
        _write_json(script_path, script)
        artifacts.append({
            "kind": "chapter_script",
            "path": str(script_path),
            "metadata": {
                "chapterId": chapter["chapterId"],
                "characterCount": len(script.get("characters", [])),
                "segmentCount": len(script.get("segments", [])),
            },
        })

    return _response("succeeded", artifacts=artifacts)


def _read_file(request: dict[str, Any]) -> dict[str, Any]:
    content = Path(request["path"]).read_text(encoding="utf-8")
    return json.loads(content)


def _write_file(request: dict[str, Any]) -> dict[str, Any]:
    path = Path(request["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(request["content"], encoding="utf-8")
    return _response("succeeded")


def _check_rights(request: dict[str, Any]) -> dict[str, Any]:
    from audiobook_worker.rights import classify_rights

    result = classify_rights(
        input_path=Path(request["bookPath"]),
        metadata=request.get("metadata", {}),
    )
    payload = _response("succeeded")
    payload["classification"] = result.classification
    payload["reason"] = result.reason
    payload["requiresAttestation"] = result.requires_attestation
    payload["evidence"] = result.evidence
    return payload


_dispatch_table: dict[str, Any] = {
    "extract_book": _extract_book,
    "analyze_chapter": _analyze_chapter,
    "synthesize_segment_audio": _synthesize_segment_audio,
    "synthesize_chapter_audio": _synthesize_chapter_audio,
    "assemble_chapter_audio": _assemble_chapter_audio,
    "apply_corrections": _apply_corrections,
    "_read_file": _read_file,
    "_write_file": _write_file,
    "check_rights": _check_rights,
}


if __name__ == "__main__":
    raise SystemExit(main())
