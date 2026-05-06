from audiobook_worker.segment_merge import merge_tts_segments


def test_merges_adjacent_segments_with_same_voice_emotion_and_pace():
    segments = [
        {"id": "seg_0001", "text": "Hello", "voiceId": "a", "emotion": "neutral", "pace": "normal"},
        {"id": "seg_0002", "text": "there.", "voiceId": "a", "emotion": "neutral", "pace": "normal"},
        {"id": "seg_0003", "text": "Stop.", "voiceId": "b", "emotion": "angry", "pace": "fast"},
    ]

    merged = merge_tts_segments(segments)

    assert len(merged) == 2
    assert merged[0]["id"] == "seg_0001"
    assert merged[0]["text"] == "Hello there."
    assert merged[0]["sourceSegmentIds"] == ["seg_0001", "seg_0002"]
    assert merged[1]["id"] == "seg_0003"


def test_does_not_merge_when_word_limit_would_be_exceeded():
    segments = [
        {"id": "seg_0001", "text": "one two three", "voiceId": "a", "emotion": "neutral", "pace": "normal"},
        {"id": "seg_0002", "text": "four five six", "voiceId": "a", "emotion": "neutral", "pace": "normal"},
    ]

    merged = merge_tts_segments(segments, max_words=5)

    assert [segment["id"] for segment in merged] == ["seg_0001", "seg_0002"]
