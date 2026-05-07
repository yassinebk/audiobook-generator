from audiobook_worker.script_builder import build_chapter_script


def test_builds_dialogue_aware_chapter_script():
    script = build_chapter_script(
        book_id="book_123",
        chapter_id="chapter_001",
        title="Chapter 1",
        text='She waited. "Come in," Elizabeth said.',
        language="en",
    )

    assert script["bookId"] == "book_123"
    assert script["chapterId"] == "chapter_001"
    assert script["characters"][0]["id"] == "elizabeth"
    assert script["characters"][0]["gender"] == "female"
    assert [segment["type"] for segment in script["segments"]] == ["narration", "dialogue", "narration"]
    assert script["segments"][1]["speakerId"] == "elizabeth"
    assert script["segments"][1]["voiceId"].startswith("female_adult_")
    assert script["segments"][1]["emotion"] == "neutral"
    assert script["segments"][1]["confidence"] >= 0.7


def test_unknown_dialogue_uses_neutral_fallback_voice():
    script = build_chapter_script(
        book_id="book_123",
        chapter_id="chapter_001",
        title="Chapter 1",
        text='"No one knows."',
        language="en",
    )

    segment = script["segments"][0]
    assert segment["speakerId"] == "unknown"
    assert segment["voiceId"] == "neutral_dialogue_01"
    assert "speaker_unknown" in segment["warnings"]

