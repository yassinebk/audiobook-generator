from __future__ import annotations

import math
import os
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

try:
    from kokoro import KPipeline
except ImportError:
    KPipeline = None  # type: ignore[assignment,misc]


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
# Kokoro TTS backend (primary)
# ---------------------------------------------------------------------------

class KokoroTTSBackend:
    backend_id = "kokoro"

    def __init__(self, lang_code: str = "a") -> None:
        self._lang_code = lang_code
        self._pipeline = None

    def synthesize_segment(self, segment: dict, output_directory: Path | str) -> AudioArtifact:
        import numpy as np
        import soundfile as sf

        self._ensure_pipeline()

        directory = Path(output_directory)
        directory.mkdir(parents=True, exist_ok=True)
        output_path = directory / f"{segment['id']}.wav"

        voice_id = segment.get("voiceId", "narrator_default")
        voice_name = _kokoro_voice_for(voice_id)
        text = segment["text"]

        generator = self._pipeline(text, voice=voice_name, speed=1.0, split_pattern=None)

        segments_audio = []
        for result in generator:
            audio_segment = result.audio
            if hasattr(audio_segment, "cpu"):
                audio_segment = audio_segment.cpu().numpy().squeeze()
            else:
                audio_segment = np.array(audio_segment).squeeze()
            if audio_segment.ndim == 1 and len(audio_segment) > 0:
                segments_audio.append(audio_segment)

        audio = np.concatenate(segments_audio) if segments_audio else np.zeros(0, dtype=np.float32)
        sf.write(str(output_path), audio, 24000)

        duration = len(audio) / 24000
        return AudioArtifact(
            kind="segment_audio",
            path=output_path,
            duration_seconds=duration,
        )

    def _ensure_pipeline(self) -> None:
        if self._pipeline is not None:
            return

        import torch

        requested_device = os.environ.get("AUDIOBOOK_TTS_DEVICE", "auto")
        kokoro_device = _select_kokoro_device(torch, requested_device)

        # KPipeline only natively supports 'cpu'/'cuda', so init on CPU first
        init_device = kokoro_device if kokoro_device in ("cpu", "cuda") else "cpu"
        self._pipeline = KPipeline(lang_code=self._lang_code, device=init_device)

        # Move model to MPS after init if available
        if kokoro_device == "mps" and self._pipeline.model is not None:
            self._pipeline.model.to("mps")
            self._pipeline.model.eval()
            self._device = "mps"
        else:
            self._device = kokoro_device


# ---------------------------------------------------------------------------
# Parler TTS backend (secondary, kept for comparison / voice-description mode)
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
        if audio_array.dtype.name == "float16":
            audio_array = audio_array.astype("float32")

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

        requested_device = os.environ.get("AUDIOBOOK_TTS_DEVICE", "auto")
        self._device = _select_torch_device(torch, requested_device)

        dtype = torch.float16 if self._device in ("mps", "cuda") else torch.float32
        self._model = ParlerTTSForConditionalGeneration.from_pretrained(
            self._model_id, torch_dtype=dtype
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
                do_sample=False,
            )

        return generation.cpu().numpy().squeeze()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def voice_registry() -> dict[str, dict]:
    return VOICE_REGISTRY.copy()


def _select_torch_device(torch_module, requested_device: str = "auto") -> str:
    requested = requested_device.strip().lower()
    if requested not in {"auto", "mps", "cuda", "cpu"}:
        raise ValueError(
            "AUDIOBOOK_TTS_DEVICE must be one of: auto, mps, cuda, cpu"
        )

    mps_available = torch_module.backends.mps.is_available()
    cuda_available = torch_module.cuda.is_available()

    if requested == "mps":
        if not mps_available:
            raise RuntimeError(
                "MPS was requested for TTS, but torch.backends.mps.is_available() is false."
            )
        return "mps"
    if requested == "cuda":
        if not cuda_available:
            raise RuntimeError(
                "CUDA was requested for TTS, but torch.cuda.is_available() is false."
            )
        return "cuda"
    if requested == "cpu":
        return "cpu"

    if mps_available:
        return "mps"
    if cuda_available:
        return "cuda"
    return "cpu"


def _select_kokoro_device(torch_module, requested_device: str = "auto") -> str:
    """Select device for Kokoro. Returns device string for KPipeline init.
    MPS acceleration is applied post-init by moving the model manually."""
    requested = requested_device.strip().lower()
    if requested == "cpu":
        return "cpu"
    if requested == "cuda" and torch_module.cuda.is_available():
        return "cuda"
    if requested in ("mps", "auto"):
        if torch_module.backends.mps.is_available():
            return "mps"
        return "cpu"
    return "cpu"


def _kokoro_voice_for(voice_id: str) -> str:
    """Map internal voice IDs to Kokoro voice names."""
    voice_entry = VOICE_REGISTRY.get(voice_id, VOICE_REGISTRY["narrator_default"])
    return voice_entry.get("kokoroVoice", "af_heart")


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
