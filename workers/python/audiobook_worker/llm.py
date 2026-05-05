from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib import request as urllib_request
from urllib.error import HTTPError

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


@dataclass(frozen=True)
class OpenAICompatibleConfig:
    provider: str
    api_key: str
    base_url: str
    model: str
    max_tokens: int | None = None
    timeout_seconds: float = 60.0


Transport = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]


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
class ResolvedModel:
    provider: str
    model_id: str
    base_url: str
    api_key: str
    api: str
    family: str
    max_tokens: int


class OpenAICompatibleAnalyzer:
    supports_real_model = True

    def __init__(
        self,
        config: OpenAICompatibleConfig,
        *,
        transport: Transport | None = None,
    ) -> None:
        self.config = config
        self._transport = transport or _post_json

    @property
    def backend_id(self) -> str:
        return self.config.provider

    def analyze_chapter(self, request: ChapterAnalysisRequest) -> ChapterAnalysisResult:
        url = f"{self.config.base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": self.config.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You convert book chapters into audiobook analysis JSON. "
                        "Return only valid JSON with keys characters and segmentAnnotations."
                    ),
                },
                {
                    "role": "user",
                    "content": _analysis_prompt(request),
                },
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        }
        if self.config.max_tokens is not None:
            payload["max_tokens"] = self.config.max_tokens
        response = self._transport(
            url,
            {
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            },
            payload,
            self.config.timeout_seconds,
        )
        content = response["choices"][0]["message"]["content"]
        return _parse_analysis_json(json.loads(content))


def default_analyzer():
    model_override = os.environ.get("AUDIOBOOK_LLM_MODEL")
    if model_override == "mock":
        return MockLLMAnalyzer()
    resolved = resolve_model(model_override)
    analyzer = analyzer_from_resolved_model(resolved) if resolved else None
    if analyzer is not None:
        return analyzer
    return MockLLMAnalyzer()


def resolve_model(model_arg: str | None = None) -> ResolvedModel | None:
    config = read_models_json()
    if config is not None:
        return resolve_model_from_config(config, model_arg)

    base_url = os.environ.get("MODEL_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
    if not base_url:
        return None
    return ResolvedModel(
        provider="env",
        model_id=os.environ.get("MODEL_ID") or os.environ.get("OPENAI_MODEL") or "gpt-4o",
        base_url=base_url,
        api_key=os.environ.get("MODEL_API_KEY") or os.environ.get("OPENAI_API_KEY") or "unused",
        api="openai-completions",
        family="default",
        max_tokens=8192,
    )


def read_models_json(paths: list[Path] | None = None) -> dict[str, Any] | None:
    search_paths = paths or [
        Path.home() / ".pi" / "agent" / "models.json",
        Path.home() / ".pi" / "models.json",
    ]
    for path in search_paths:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
    return None


def resolve_model_from_config(config: dict[str, Any], model_arg: str | None = None) -> ResolvedModel:
    lookup = model_arg or config.get("default")
    providers = config.get("providers", {})
    if lookup:
        provider_name, *segments = lookup.split("/")
        provider_config = providers.get(provider_name)
        if provider_config:
            model_entry, model_id = _find_model_entry(provider_name, provider_config, segments)
            return _resolved_model(provider_name, provider_config, model_entry, model_id)

        for candidate_provider, candidate_config in providers.items():
            for model in candidate_config.get("models", []):
                if model.get("id") == lookup:
                    return _resolved_model(candidate_provider, candidate_config, model, lookup)
            prefix = f"{candidate_provider}/"
            if lookup.startswith(prefix):
                stripped = lookup[len(prefix) :]
                for model in candidate_config.get("models", []):
                    if model.get("id") == stripped:
                        return _resolved_model(candidate_provider, candidate_config, model, stripped)

    provider_name, provider_config = next(iter(providers.items()))
    model_entry = provider_config.get("models", [{}])[0]
    return _resolved_model(provider_name, provider_config, model_entry, model_entry.get("id", "default"))


def analyzer_from_models_config(
    config: dict[str, Any],
    model_arg: str | None = None,
    *,
    transport: Transport | None = None,
) -> OpenAICompatibleAnalyzer | MockLLMAnalyzer:
    analyzer = analyzer_from_resolved_model(
        resolve_model_from_config(config, model_arg),
        transport=transport,
    )
    return analyzer or MockLLMAnalyzer()


def analyzer_from_resolved_model(
    resolved: ResolvedModel,
    *,
    transport: Transport | None = None,
) -> OpenAICompatibleAnalyzer | None:
    if resolved.api != "openai-completions":
        return None
    return OpenAICompatibleAnalyzer(
        OpenAICompatibleConfig(
            provider=resolved.provider,
            api_key=resolved.api_key,
            base_url=resolved.base_url,
            model=resolved.model_id,
            max_tokens=resolved.max_tokens,
        ),
        transport=transport,
    )


def _find_model_entry(
    provider: str,
    provider_config: dict[str, Any],
    segments: list[str],
) -> tuple[dict[str, Any], str]:
    models = provider_config.get("models", [])
    resolved_model_id = "/".join(segments)
    full_model_id = f"{provider}/{resolved_model_id}" if resolved_model_id else provider
    for model in models:
        if model.get("id") == full_model_id:
            return model, full_model_id
    for start in range(0, len(segments) + 1):
        candidate = "/".join(segments[start:])
        for model in models:
            if model.get("id") == candidate:
                return model, candidate
    return {}, resolved_model_id


def _resolved_model(
    provider: str,
    provider_config: dict[str, Any],
    model_entry: dict[str, Any],
    model_id: str,
) -> ResolvedModel:
    return ResolvedModel(
        provider=provider,
        model_id=model_id,
        base_url=provider_config["baseUrl"],
        api_key=_resolve_api_key(provider_config),
        api=provider_config.get("api", "openai-completions"),
        family=provider_config.get("family", "default"),
        max_tokens=int(model_entry.get("maxTokens", 8192)),
    )


def _resolve_api_key(provider_config: dict[str, Any]) -> str:
    if provider_config.get("apiKey"):
        return str(provider_config["apiKey"])
    if provider_config.get("apiKeyEnv"):
        return os.environ.get(str(provider_config["apiKeyEnv"]), "")
    return "unused"


def _speaker_id(name: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return normalized or "unknown"


def _analysis_prompt(request: ChapterAnalysisRequest) -> str:
    segments = segment_dialogue(request.text)
    segment_lines = [
        {
            "segmentIndex": index,
            "type": segment.type,
            "text": segment.text,
            "speakerHint": segment.speaker_hint,
            "warnings": segment.warnings,
        }
        for index, segment in enumerate(segments)
    ]
    return json.dumps(
        {
            "bookId": request.book_id,
            "chapterId": request.chapter_id,
            "language": request.language,
            "segments": segment_lines,
            "schema": {
                "characters": [
                    {
                        "id": "snake_case_id",
                        "canonicalName": "display name",
                        "aliases": ["alias"],
                        "gender": "female|male|neutral|unknown",
                        "ageClass": "child|young|adult|older|unknown",
                        "confidence": 0.0,
                    }
                ],
                "segmentAnnotations": [
                    {
                        "segmentIndex": 0,
                        "speakerId": "character_id|unknown|narrator",
                        "emotion": "neutral|happy|sad|angry|afraid|tense|whispering|excited|tired",
                        "confidence": 0.0,
                        "warnings": ["optional_warning"],
                    }
                ],
            },
        },
        ensure_ascii=False,
    )


def _parse_analysis_json(payload: dict[str, Any]) -> ChapterAnalysisResult:
    characters = [
        CharacterAnalysis(
            id=str(item["id"]),
            canonical_name=str(item["canonicalName"]),
            aliases=[str(alias) for alias in item.get("aliases", [])],
            gender=str(item.get("gender", "unknown")),
            age_class=str(item.get("ageClass", "unknown")),
            confidence=float(item.get("confidence", 0.0)),
        )
        for item in payload.get("characters", [])
    ]
    annotations = [
        SegmentAnnotation(
            segment_index=int(item["segmentIndex"]),
            speaker_id=str(item.get("speakerId", "unknown")),
            emotion=str(item.get("emotion", "neutral")),
            confidence=float(item.get("confidence", 0.0)),
            warnings=[str(warning) for warning in item.get("warnings", [])],
        )
        for item in payload.get("segmentAnnotations", [])
    ]
    return ChapterAnalysisResult(characters=characters, segment_annotations=annotations)


def _post_json(
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: float,
) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"DeepSeek request failed with HTTP {error.code}: {detail}") from error


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
