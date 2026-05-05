from __future__ import annotations

from audiobook_worker.dialogue import segment_dialogue
from audiobook_worker.llm import ChapterAnalysisRequest, MockLLMAnalyzer


VOICE_REGISTRY = {
    "narrator_default": {
        "id": "narrator_default",
        "displayName": "Default Narrator",
        "genderPresentation": "neutral",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "tense", "sad", "happy"],
        "backend": "parler",
        "licenseNotes": "Parler TTS Apache 2.0",
        "parlerDescription": (
            "A middle-aged male speaker with a warm, clear, and measured voice "
            "delivers the narration at a comfortable pace in a quiet studio environment. "
            "The recording is clean with no background noise."
        ),
    },
    "female_adult_01": {
        "id": "female_adult_01",
        "displayName": "Female Adult 01",
        "genderPresentation": "female",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "afraid", "happy", "sad", "angry", "excited"],
        "backend": "parler",
        "licenseNotes": "Parler TTS Apache 2.0",
        "parlerDescription": (
            "A young adult female speaker with a clear, expressive voice "
            "delivers her lines in a quiet indoor setting. "
            "The recording is crisp with no background noise."
        ),
    },
    "male_adult_01": {
        "id": "male_adult_01",
        "displayName": "Male Adult 01",
        "genderPresentation": "male",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral", "angry", "tense", "excited"],
        "backend": "parler",
        "licenseNotes": "Parler TTS Apache 2.0",
        "parlerDescription": (
            "An adult male speaker with a deep, resonant voice "
            "delivers his lines in a quiet indoor setting. "
            "The recording is clean with no background noise."
        ),
    },
    "neutral_dialogue_01": {
        "id": "neutral_dialogue_01",
        "displayName": "Neutral Dialogue 01",
        "genderPresentation": "neutral",
        "ageClass": "adult",
        "languages": ["en"],
        "styles": ["neutral"],
        "backend": "parler",
        "licenseNotes": "Parler TTS Apache 2.0",
        "parlerDescription": (
            "A speaker with a clear, neutral voice delivers dialogue "
            "in a quiet studio environment. "
            "The recording has no background noise."
        ),
    },
}


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


def _character_to_script(character) -> dict:
    voice_id = _voice_for_gender(character.gender)
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


def _voice_for_gender(gender: str) -> str:
    if gender == "female":
        return "female_adult_01"
    if gender == "male":
        return "male_adult_01"
    return "neutral_dialogue_01"


def _emotion_intensity(emotion: str) -> float:
    if emotion in {"angry", "afraid", "excited"}:
        return 0.7
    if emotion in {"tense", "sad", "happy"}:
        return 0.45
    return 0.2
