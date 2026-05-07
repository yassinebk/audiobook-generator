from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib import request as urllib_request
from urllib.error import HTTPError

from audiobook_worker.dialogue import segment_dialogue


@dataclass(frozen=True)
class CharacterContext:
    """A character already identified in a previous chapter, passed for consistency."""
    id: str
    canonical_name: str
    aliases: list[str]
    gender: str


@dataclass(frozen=True)
class ChapterAnalysisRequest:
    book_id: str
    chapter_id: str
    text: str
    language: str
    known_characters: list[CharacterContext] = field(default_factory=list)


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
    timeout_seconds: float = 120.0
    max_retries: int = 3


Transport = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]

_SYSTEM_PROMPT = """\
You are an audiobook script analyst. Your job is to analyse a book chapter and produce a \
structured JSON identifying speaking characters and annotating each dialogue segment.

## Rules for characters
- Use a stable snake_case `id` derived from the character's most common name \
  (e.g. "elizabeth_bennet", "mr_darcy"). NEVER change an id between chapters.
- `canonicalName` is the full display name used in the book (e.g. "Elizabeth Bennet").
- List all known shorter forms, nicknames, and titles in `aliases` \
  (e.g. ["Lizzy", "Miss Bennet", "Eliza"]).
- `gender`: "female" | "male" | "neutral" | "unknown". Infer from pronouns and context.
- `ageClass`: "child" | "young" | "adult" | "older" | "unknown".
- `confidence`: 0.0–1.0, reflect how sure you are the character is correctly identified.
- If a character already appears in `knownCharacters`, reuse their exact `id` and \
  `canonicalName`. Do NOT create a new entry for the same person.

## Rules for segmentAnnotations
- Annotate every segment in the input, including narration (speakerId = "narrator").
- For dialogue with a known speaker, use their `id` from the characters list.
- For dialogue with no identifiable speaker, use speakerId = "unknown".
- `emotion`: "neutral" | "happy" | "sad" | "angry" | "afraid" | "tense" | \
  "whispering" | "excited" | "tired". Choose the most contextually appropriate.
- `confidence`: how sure you are about the speaker attribution (0.0–1.0).
- Only add `warnings` for genuine ambiguity (e.g. ["speaker_ambiguous"]).

## Output format
Return a single JSON object with exactly two keys: `characters` and `segmentAnnotations`. \
No markdown, no extra commentary — only the JSON object.
"""


class MockLLMAnalyzer:
    backend_id = "mock"
    supports_real_model = False

    def analyze_chapter(self, request: ChapterAnalysisRequest) -> ChapterAnalysisResult:
        segments = segment_dialogue(request.text)
        characters: dict[str, CharacterAnalysis] = {}

        # Seed with known characters so mock doesn't duplicate them
        for kc in request.known_characters:
            characters[kc.id] = CharacterAnalysis(
                id=kc.id,
                canonical_name=kc.canonical_name,
                aliases=kc.aliases,
                gender=kc.gender,
                age_class="adult",
                confidence=0.78,
            )

        annotations: list[SegmentAnnotation] = []

        for index, segment in enumerate(segments):
            if segment.type != "dialogue":
                continue

            speaker = segment.speaker_hint or "unknown"
            speaker_id = _speaker_id(speaker)

            # Check if known character matches (by name/alias)
            resolved_id = _resolve_known_character(speaker, request.known_characters)
            if resolved_id:
                speaker_id = resolved_id
            elif speaker != "unknown" and speaker_id not in characters:
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
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": _analysis_prompt(request)},
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        }
        if self.config.max_tokens is not None:
            payload["max_tokens"] = self.config.max_tokens

        last_error: Exception | None = None
        for attempt in range(self.config.max_retries):
            try:
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
            except Exception as exc:
                last_error = exc
                if attempt < self.config.max_retries - 1:
                    # Exponential backoff: 1s, 2s, 4s
                    time.sleep(2 ** attempt)
                    continue

        raise RuntimeError(
            f"LLM analysis failed after {self.config.max_retries} attempts: {last_error}"
        ) from last_error


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
                stripped = lookup[len(prefix):]
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
    prefix = f"{provider}/"
    if model_id.startswith(prefix):
        model_id = model_id[len(prefix):]
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


def _resolve_known_character(name: str, known: list[CharacterContext]) -> str | None:
    """Return the id of a known character whose canonical name or alias matches."""
    name_lower = name.lower().strip()
    for kc in known:
        if kc.canonical_name.lower() == name_lower:
            return kc.id
        if any(alias.lower() == name_lower for alias in kc.aliases):
            return kc.id
    return None


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

    payload: dict[str, Any] = {
        "chapterId": request.chapter_id,
        "language": request.language,
        "segments": segment_lines,
    }

    if request.known_characters:
        payload["knownCharacters"] = [
            {
                "id": kc.id,
                "canonicalName": kc.canonical_name,
                "aliases": kc.aliases,
                "gender": kc.gender,
            }
            for kc in request.known_characters
        ]

    return json.dumps(payload, ensure_ascii=False)


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
        raise RuntimeError(f"LLM request failed with HTTP {error.code}: {detail}") from error


def _guess_gender(name: str) -> str:
    if name.lower() in {"elizabeth", "jane", "mary", "anna", "emma"}:
        return "female"
    if name.lower() in {"darcy", "john", "william", "charles"}:
        return "male"
    return "unknown"


def _guess_emotion(text: str) -> str:
    lowered = text.lower()
    if any(word in lowered for word in ["whispered", "murmured", "breathed"]):
        return "whispering"
    if any(word in lowered for word in ["afraid", "scared", "terrified", "fear"]):
        return "afraid"
    if any(word in lowered for word in ["sobbed", "cried", "wept", "tearfully"]):
        return "sad"
    if any(word in lowered for word in ["shouted", "cried out", "exclaimed", "snapped"]):
        return "angry"
    if "!" in text:
        return "excited"
    return "neutral"
