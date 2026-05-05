from audiobook_worker.dialogue import segment_dialogue


def test_splits_narration_and_quoted_dialogue_in_source_order():
    text = 'She opened the door. "Who is there?" The hallway was empty.'

    segments = segment_dialogue(text)

    assert [segment.type for segment in segments] == ["narration", "dialogue", "narration"]
    assert [segment.text for segment in segments] == [
        "She opened the door.",
        "Who is there?",
        "The hallway was empty.",
    ]
    assert segments[1].start_offset == text.index('"Who')


def test_infers_speaker_from_trailing_speech_tag():
    text = '"Come in," Elizabeth said. Darcy waited.'

    segments = segment_dialogue(text)

    assert segments[0].type == "dialogue"
    assert segments[0].speaker_hint == "Elizabeth"
    assert segments[0].warnings == []


def test_alternating_dialogue_without_tags_is_marked_uncertain():
    text = '"Hello."\n"Good morning."'

    segments = segment_dialogue(text)

    assert [segment.type for segment in segments] == ["dialogue", "dialogue"]
    assert all(segment.speaker_hint is None for segment in segments)
    assert all("speaker_unknown" in segment.warnings for segment in segments)

