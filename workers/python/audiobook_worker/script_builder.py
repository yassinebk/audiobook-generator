from __future__ import annotations

import hashlib
import re

from audiobook_worker.dialogue import segment_dialogue
from audiobook_worker.llm import ChapterAnalysisRequest, MockLLMAnalyzer


VOICE_REGISTRY = {
    # ── Narrators ───────────────────────────────────────────────────────
    "narrator_default": {
        "id": "narrator_default",
        "displayName": "Narrator (Warm Female)",
        "genderPresentation": "neutral",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "tense", "sad", "happy"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "af_heart",
    },
    "narrator_female": {
        "id": "narrator_female",
        "displayName": "Narrator (Female)",
        "genderPresentation": "neutral",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "tense", "sad", "happy"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "bf_emma",
    },

    # ── Female voices (5 distinct) ──────────────────────────────────────
    "female_adult_01": {
        "id": "female_adult_01",
        "displayName": "Female — Warm & Expressive",
        "genderPresentation": "female",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "happy", "sad", "angry", "excited", "afraid"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "af_heart",
    },
    "female_adult_02": {
        "id": "female_adult_02",
        "displayName": "Female — Bright & Clear",
        "genderPresentation": "female",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "happy", "excited", "angry"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "af_bella",
    },
    "female_adult_03": {
        "id": "female_adult_03",
        "displayName": "Female — Gentle & Soft",
        "genderPresentation": "female",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "sad", "afraid", "happy"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "af_nicole",
    },
    "female_adult_04": {
        "id": "female_adult_04",
        "displayName": "Female — Energetic & Lively",
        "genderPresentation": "female",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "excited", "happy", "angry"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "af_sky",
    },
    "female_adult_05": {
        "id": "female_adult_05",
        "displayName": "Female — Measured & Elegant",
        "genderPresentation": "female",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "tense", "sad", "happy"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "af_sarah",
    },

    # ── Male voices (5 distinct) ────────────────────────────────────────
    "male_adult_01": {
        "id": "male_adult_01",
        "displayName": "Male — Deep & Resonant",
        "genderPresentation": "male",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "angry", "tense", "excited"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "am_michael",
    },
    "male_adult_02": {
        "id": "male_adult_02",
        "displayName": "Male — Crisp & Articulate",
        "genderPresentation": "male",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "tense", "happy", "angry"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "am_liam",
    },
    "male_adult_03": {
        "id": "male_adult_03",
        "displayName": "Male — Warm & Friendly",
        "genderPresentation": "male",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "happy", "excited", "sad"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "am_onyx",
    },
    "male_adult_04": {
        "id": "male_adult_04",
        "displayName": "Male — Strong & Authoritative",
        "genderPresentation": "male",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "angry", "tense", "excited"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "am_eric",
    },
    "male_adult_05": {
        "id": "male_adult_05",
        "displayName": "Male — Measured & Calm",
        "genderPresentation": "male",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "sad", "tense", "happy"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "am_puck",
    },

    # ── British voices (for period works like Austen) ────────────────────
    "female_british_01": {
        "id": "female_british_01",
        "displayName": "Female — British (Bright)",
        "genderPresentation": "female",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "happy", "excited", "sad"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "bf_isabella",
    },
    "female_british_02": {
        "id": "female_british_02",
        "displayName": "Female — British (Elegant)",
        "genderPresentation": "female",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "tense", "sad", "happy"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "bf_lily",
    },
    "male_british_01": {
        "id": "male_british_01",
        "displayName": "Male — British (Refined)",
        "genderPresentation": "male",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "angry", "tense", "happy"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "bm_george",
    },
    "male_british_02": {
        "id": "male_british_02",
        "displayName": "Male — British (Warm)",
        "genderPresentation": "male",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "happy", "sad", "excited"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "bm_lewis",
    },

    # ── Neutral / fallback ──────────────────────────────────────────────
    "neutral_dialogue_01": {
        "id": "neutral_dialogue_01",
        "displayName": "Neutral Dialogue",
        "genderPresentation": "neutral",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral"],
        "backend": "kokoro",
        "licenseNotes": "Kokoro-82M Apache 2.0",
        "kokoroVoice": "af_nicole",
    },
}

# Voice pools for deterministic round-robin assignment per gender.
# Characters with the same gender get different voices based on name hash.
_FEMALE_VOICE_POOL = [
    "female_adult_01",
    "female_adult_02",
    "female_adult_03",
    "female_adult_04",
    "female_adult_05",
]

_MALE_VOICE_POOL = [
    "male_adult_01",
    "male_adult_02",
    "male_adult_03",
    "male_adult_04",
    "male_adult_05",
]


def build_chapter_script(
    *,
    book_id: str,
    chapter_id: str,
    title: str,
    text: str,
    language: str,
    analyzer=None,
) -> dict:
    raw_segments = segment_dialogue(text)
    analyzer = analyzer or MockLLMAnalyzer()
    analysis = analyzer.analyze_chapter(
        ChapterAnalysisRequest(
            book_id=book_id,
            chapter_id=chapter_id,
            text=text,
            language=language,
        )
    )
    annotations = {
        annotation.segment_index: annotation for annotation in analysis.segment_annotations
    }
    characters = [_character_to_script(character) for character in analysis.characters]

    segments = []
    voice_ids = {"narrator_default"}
    for index, raw_segment in enumerate(raw_segments):
        annotation = annotations.get(index)
        speaker_id = "narrator"
        emotion = "neutral"
        confidence = 0.9
        warnings = list(raw_segment.warnings)

        if raw_segment.type == "dialogue":
            speaker_id = annotation.speaker_id if annotation else "unknown"
            emotion = annotation.emotion if annotation else "neutral"
            confidence = annotation.confidence if annotation else 0.35
            if annotation:
                warnings = sorted(set(warnings + annotation.warnings))

        voice_id = _assign_voice(speaker_id, characters)
        voice_ids.add(voice_id)
        segments.append(
            {
                "id": f"seg_{index + 1:04d}",
                "type": raw_segment.type,
                "text": raw_segment.text,
                "speakerId": speaker_id,
                "voiceId": voice_id,
                "emotion": emotion,
                "intensity": _emotion_intensity(emotion),
                "pace": "normal",
                "confidence": confidence,
                "source": {
                    "startOffset": raw_segment.start_offset,
                    "endOffset": raw_segment.end_offset,
                },
                "warnings": warnings,
            }
        )

    return {
        "bookId": book_id,
        "chapterId": chapter_id,
        "title": title,
        "language": language,
        "characters": characters,
        "voices": [VOICE_REGISTRY[voice_id] for voice_id in sorted(voice_ids)],
        "segments": segments,
    }


def build_chapter_script_with_corrections(
    *,
    book_id: str,
    chapter_id: str,
    title: str,
    text: str,
    language: str,
    corrections: dict,
    analyzer=None,
) -> dict:
    if corrections is None:
        raise ValueError("corrections must be a dict, got None")
    if not isinstance(corrections, dict):
        raise ValueError(
            f"corrections must be a dict, got {type(corrections).__name__}"
        )

    for item in corrections.get("aliasMerges", []):
        if "from" not in item:
            raise KeyError("aliasMerges item missing required key 'from'")
        if "to" not in item:
            raise KeyError("aliasMerges item missing required key 'to'")

    for item in corrections.get("genderOverrides", []):
        if "characterId" not in item:
            raise KeyError("genderOverrides item missing required key 'characterId'")
        if "gender" not in item:
            raise KeyError("genderOverrides item missing required key 'gender'")

    for item in corrections.get("voiceOverrides", []):
        if "characterId" not in item:
            raise KeyError("voiceOverrides item missing required key 'characterId'")
        if "voiceId" not in item:
            raise KeyError("voiceOverrides item missing required key 'voiceId'")

    alias_map: dict[str, str] = {}
    for merge in corrections.get("aliasMerges", []):
        alias_map[merge["from"].lower()] = merge["to"]

    if alias_map:
        for alias, canonical in alias_map.items():
            pattern = re.compile(
                r"\b" + re.escape(alias) + r"\b", re.IGNORECASE
            )
            text = pattern.sub(canonical, text)

    gender_overrides: dict[str, str] = {}
    for override in corrections.get("genderOverrides", []):
        gender_overrides[override["characterId"]] = override["gender"]

    voice_overrides: dict[str, str] = {}
    for override in corrections.get("voiceOverrides", []):
        voice_overrides[override["characterId"]] = override["voiceId"]

    script = build_chapter_script(
        book_id=book_id,
        chapter_id=chapter_id,
        title=title,
        text=text,
        language=language,
        analyzer=analyzer,
    )

    for character in script["characters"]:
        char_id = character["id"]
        if char_id in gender_overrides:
            character["gender"] = gender_overrides[char_id]
            character["voiceId"] = _voice_for_gender(gender_overrides[char_id])
        if char_id in voice_overrides:
            character["voiceId"] = voice_overrides[char_id]

    for segment in script["segments"]:
        speaker_id = segment["speakerId"]
        if speaker_id in voice_overrides:
            segment["voiceId"] = voice_overrides[speaker_id]
        elif speaker_id in gender_overrides:
            segment["voiceId"] = _voice_for_gender(gender_overrides[speaker_id])

    voice_ids = {s["voiceId"] for s in script["segments"]}
    voice_ids.add("narrator_default")
    script["voices"] = [
        VOICE_REGISTRY[vid] for vid in sorted(voice_ids) if vid in VOICE_REGISTRY
    ]

    return script


def _character_to_script(character) -> dict:
    voice_id = _voice_for_gender(character.gender, character.id)
    return {
        "id": character.id,
        "canonicalName": character.canonical_name,
        "aliases": character.aliases,
        "gender": character.gender,
        "ageClass": character.age_class,
        "voiceId": voice_id,
        "confidence": character.confidence,
    }


def _assign_voice(speaker_id: str, characters: list[dict]) -> str:
    if speaker_id == "narrator":
        return "narrator_default"
    for character in characters:
        if character["id"] == speaker_id:
            return character["voiceId"]
    return "neutral_dialogue_01"


def _voice_for_gender(gender: str, character_id: str = "") -> str:
    """Pick a distinct voice for a character based on gender and name hash.
    
    Uses deterministic hash of the character_id so the same character always
    gets the same voice, while different characters get different voices.
    """
    if gender == "female":
        pool = _FEMALE_VOICE_POOL
    elif gender == "male":
        pool = _MALE_VOICE_POOL
    else:
        return "neutral_dialogue_01"

    if not character_id:
        return pool[0]

    # Deterministic but distributed: hash the character id to pick from pool
    hash_bytes = hashlib.sha256(character_id.lower().encode()).digest()
    index = int.from_bytes(hash_bytes[:4], "big") % len(pool)
    return pool[index]


def _emotion_intensity(emotion: str) -> float:
    if emotion in {"angry", "afraid", "excited"}:
        return 0.7
    if emotion in {"tense", "sad", "happy"}:
        return 0.45
    return 0.2
