from __future__ import annotations

import math
import wave
from dataclasses import dataclass
from pathlib import Path

from audiobook_worker.script_builder import VOICE_REGISTRY


@dataclass(frozen=True)
class AudioArtifact:
    kind: str
    path: Path
    duration_seconds: float


class MockTTSBackend:
    backend_id = "mock"

    def synthesize_segment(self, segment: dict, output_directory: Path | str) -> AudioArtifact:
        directory = Path(output_directory)
        directory.mkdir(parents=True, exist_ok=True)
        output_path = directory / f"{segment['id']}.wav"
        duration = _duration_for_text(segment.get("text", ""))
        _write_silence(output_path, duration_seconds=duration)
        return AudioArtifact(
            kind="segment_audio",
            path=output_path,
            duration_seconds=duration,
        )


def voice_registry() -> dict[str, dict]:
    return VOICE_REGISTRY.copy()


def _duration_for_text(text: str) -> float:
    word_count = len(text.split())
    return max(0.25, min(2.0, word_count * 0.08))


def _write_silence(path: Path, *, duration_seconds: float) -> None:
    sample_rate = 16_000
    frame_count = math.ceil(sample_rate * duration_seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * frame_count)

