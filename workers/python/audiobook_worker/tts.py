from __future__ import annotations

import math
import wave
from dataclasses import dataclass
from pathlib import Path

from audiobook_worker.script_builder import VOICE_REGISTRY

# ---------------------------------------------------------------------------
# Shared data
# ---------------------------------------------------------------------------

_EMOTION_MODIFIERS: dict[str, str] = {
    "angry": "The speaker sounds angry and forceful, with sharp emphasis on stressed words.",
    "afraid": "The speaker sounds fearful and tense, with a slightly trembling, hushed delivery.",
    "sad": "The speaker sounds sorrowful and subdued, with a slow, quiet, measured pace.",
    "happy": "The speaker sounds warm and cheerful, with a light, upbeat cadence.",
    "excited": "The speaker sounds enthusiastic and energetic, speaking at a brisk, lively pace.",
    "tense": "The speaker sounds tense and guarded, with clipped, deliberate phrasing.",
    "neutral": "The speaker delivers the text clearly and evenly, without strong emotional colour.",
}

_PACE_MODIFIERS: dict[str, str] = {
    "slow": "The pace is slow and unhurried.",
    "normal": "",
    "fast": "The pace is quick and urgent.",
}

_DEFAULT_MODEL_ID = "parler-tts/parler-tts-mini-v1"


# ---------------------------------------------------------------------------
# Optional imports — declared at module level so tests can patch them
# ---------------------------------------------------------------------------

try:
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer
except ImportError:
    ParlerTTSForConditionalGeneration = None  # type: ignore[assignment,misc]
    AutoTokenizer = None  # type: ignore[assignment,misc]


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AudioArtifact:
    kind: str
    path: Path
    duration_seconds: float


# ---------------------------------------------------------------------------
# Mock backend (used in tests / offline)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Parler TTS backend
# ---------------------------------------------------------------------------

class ParlerTTSBackend:
    backend_id = "parler"

    def __init__(self, model_id: str = _DEFAULT_MODEL_ID) -> None:
        self._model_id = model_id
        self._model = None
        self._tokenizer = None
        self._device: str | None = None

    def synthesize_segment(self, segment: dict, output_directory: Path | str) -> AudioArtifact:
        import soundfile as sf

        self._ensure_model()

        directory = Path(output_directory)
        directory.mkdir(parents=True, exist_ok=True)
        output_path = directory / f"{segment['id']}.wav"

        description = self._build_description(segment)
        text = segment["text"]

        audio_array = self._generate(description, text)

        sf.write(str(output_path), audio_array, self._model.config.sampling_rate)

        duration = len(audio_array) / self._model.config.sampling_rate
        return AudioArtifact(
            kind="segment_audio",
            path=output_path,
            duration_seconds=duration,
        )

    def _ensure_model(self) -> None:
        if self._model is not None:
            return

        import torch

        if torch.backends.mps.is_available():
            self._device = "mps"
        elif torch.cuda.is_available():
            self._device = "cuda"
        else:
            self._device = "cpu"

        self._model = ParlerTTSForConditionalGeneration.from_pretrained(
            self._model_id
        ).to(self._device)
        self._tokenizer = AutoTokenizer.from_pretrained(self._model_id)

    def _build_description(self, segment: dict) -> str:
        voice_id = segment.get("voiceId", "narrator_default")
        voice_entry = VOICE_REGISTRY.get(voice_id, VOICE_REGISTRY["narrator_default"])
        base = voice_entry.get("parlerDescription", "A clear speaker.")

        emotion = segment.get("emotion", "neutral")
        pace = segment.get("pace", "normal")

        emotion_mod = _EMOTION_MODIFIERS.get(emotion, _EMOTION_MODIFIERS["neutral"])
        pace_mod = _PACE_MODIFIERS.get(pace, "")

        parts = [base, emotion_mod]
        if pace_mod:
            parts.append(pace_mod)
        return " ".join(p for p in parts if p)

    def _generate(self, description: str, text: str):
        import torch

        desc_ids = self._tokenizer(description, return_tensors="pt").input_ids.to(self._device)
        prompt_ids = self._tokenizer(text, return_tensors="pt").input_ids.to(self._device)

        with torch.inference_mode():
            generation = self._model.generate(
                input_ids=desc_ids,
                prompt_input_ids=prompt_ids,
            )

        return generation.cpu().numpy().squeeze()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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
