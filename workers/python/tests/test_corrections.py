from audiobook_worker.script_builder import build_chapter_script_with_corrections


def test_alias_merge_replaces_speaker_in_segments():
    script = build_chapter_script_with_corrections(
        book_id="book_1",
        chapter_id="ch01",
        title="Chapter 1",
        text='"Over here," Lizzy called. "Coming," Elizabeth replied.',
        language="en",
        corrections={
            "aliasMerges": [{"from": "Lizzy", "to": "Elizabeth"}],
        },
    )

    speakers = {seg["speakerId"] for seg in script["segments"] if seg["type"] == "dialogue"}
    assert speakers == {"elizabeth"}
    assert "lizzy" not in speakers


def test_gender_override_changes_character_and_voice():
    script = build_chapter_script_with_corrections(
        book_id="book_1",
        chapter_id="ch01",
        title="Chapter 1",
        text='"Indeed," said Darcy.',
        language="en",
        corrections={
            "genderOverrides": [{"characterId": "darcy", "gender": "female"}],
        },
    )

    character = next(c for c in script["characters"] if c["id"] == "darcy")
    assert character["gender"] == "female"
    assert character["voiceId"] == "female_adult_01"


def test_voice_override_changes_assigned_voice():
    script = build_chapter_script_with_corrections(
        book_id="book_1",
        chapter_id="ch01",
        title="Chapter 1",
        text='"Indeed," said Darcy.',
        language="en",
        corrections={
            "voiceOverrides": [{"characterId": "darcy", "voiceId": "neutral_dialogue_01"}],
        },
    )

    character = next(c for c in script["characters"] if c["id"] == "darcy")
    assert character["voiceId"] == "neutral_dialogue_01"

    # segments should use the overridden voice
    segments_with_darcy = [s for s in script["segments"] if s["speakerId"] == "darcy"]
    assert all(s["voiceId"] == "neutral_dialogue_01" for s in segments_with_darcy)


def test_no_corrections_returns_same_as_build_chapter_script():
    from audiobook_worker.script_builder import build_chapter_script

    kwargs = dict(
        book_id="book_1",
        chapter_id="ch01",
        title="Chapter 1",
        text='"Indeed," said Darcy.',
        language="en",
    )
    baseline = build_chapter_script(**kwargs)
    corrected = build_chapter_script_with_corrections(**kwargs, corrections={})

    assert corrected["segments"] == baseline["segments"]
    assert corrected["characters"] == baseline["characters"]
