from audiobook_worker.llm import ChapterAnalysisRequest, MockLLMAnalyzer


def test_mock_adapter_returns_characters_speaker_emotion_and_confidence():
    analyzer = MockLLMAnalyzer()
    request = ChapterAnalysisRequest(
        book_id="book_123",
        chapter_id="chapter_001",
        text='"Come in," Elizabeth said. Darcy waited.',
        language="en",
    )

    result = analyzer.analyze_chapter(request)

    assert result.characters[0].canonical_name == "Elizabeth"
    assert result.characters[0].gender == "female"
    assert result.segment_annotations[0].speaker_id == "elizabeth"
    assert result.segment_annotations[0].emotion == "neutral"
    assert result.segment_annotations[0].confidence >= 0.7


def test_real_backend_configuration_is_declared_but_disabled_by_default():
    analyzer = MockLLMAnalyzer()

    assert analyzer.backend_id == "mock"
    assert analyzer.supports_real_model is False

