from __future__ import annotations

import re
from dataclasses import dataclass, field

from audiobook_worker.dialogue import segment_dialogue


@dataclass(frozen=True)
class ChapterAnalysisRequest:
    book_id: str
    chapter_id: str
    text: str
    language: str


@dataclass(frozen=True)
class CharacterAnalysis:
    id: str
    canonical_name: str
    aliases: list[str]
    gender: str
    age_class: str
    confidence: float


@dataclass(frozen=True)
class SegmentAnnotation:
    segment_index: int
    speaker_id: str
    emotion: str
    confidence: float
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ChapterAnalysisResult:
    characters: list[CharacterAnalysis]
    segment_annotations: list[SegmentAnnotation]


class MockLLMAnalyzer:
    backend_id = "mock"
    supports_real_model = False

    def analyze_chapter(self, request: ChapterAnalysisRequest) -> ChapterAnalysisResult:
        segments = segment_dialogue(request.text)
        characters: dict[str, CharacterAnalysis] = {}
        annotations: list[SegmentAnnotation] = []

        for index, segment in enumerate(segments):
            if segment.type != "dialogue":
                continue

            speaker = segment.speaker_hint or "unknown"
            speaker_id = _speaker_id(speaker)
            if speaker != "unknown" and speaker_id not in characters:
                characters[speaker_id] = CharacterAnalysis(
                    id=speaker_id,
                    canonical_name=speaker,
                    aliases=[],
                    gender=_guess_gender(speaker),
                    age_class="adult",
                    confidence=0.78,
                )

            confidence = 0.76 if speaker != "unknown" else 0.35
            annotations.append(
                SegmentAnnotation(
                    segment_index=index,
                    speaker_id=speaker_id,
                    emotion=_guess_emotion(segment.text),
                    confidence=confidence,
                    warnings=[] if speaker != "unknown" else ["speaker_unknown"],
                )
            )

        return ChapterAnalysisResult(
            characters=list(characters.values()),
            segment_annotations=annotations,
        )


@dataclass(frozen=True)
class LocalLLMBackendConfig:
    backend_id: str
    base_url: str
    model: str
    enabled: bool = False


def _speaker_id(name: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return normalized or "unknown"


def _guess_gender(name: str) -> str:
    if name.lower() in {"elizabeth", "jane", "mary", "anna", "emma"}:
        return "female"
    if name.lower() in {"darcy", "john", "william", "charles"}:
        return "male"
    return "unknown"


def _guess_emotion(text: str) -> str:
    lowered = text.lower()
    if "!" in text:
        return "excited"
    if "?" in text:
        return "neutral"
    if any(word in lowered for word in ["afraid", "scared", "terrified"]):
        return "afraid"
    return "neutral"

