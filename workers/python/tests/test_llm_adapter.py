import json

from audiobook_worker.llm import (
    ChapterAnalysisRequest,
    MockLLMAnalyzer,
    OpenAICompatibleAnalyzer,
    OpenAICompatibleConfig,
    analyzer_from_models_config,
    resolve_model_from_config,
)


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


def test_resolves_default_deepseek_model_from_pi_models_config():
    resolved = resolve_model_from_config(
        {
            "default": "deepseek/deepseek-v4-pro",
            "providers": {
                "deepseek": {
                    "baseUrl": "https://api.deepseek.com/v1",
                    "api": "openai-completions",
                    "apiKey": "test-key",
                    "family": "deepseek",
                    "models": [
                        {
                            "id": "deepseek/deepseek-v4-pro",
                            "name": "DeepSeek V4 Pro",
                            "maxTokens": 384000,
                        }
                    ],
                }
            },
        }
    )

    assert resolved.provider == "deepseek"
    assert resolved.model_id == "deepseek/deepseek-v4-pro"
    assert resolved.base_url == "https://api.deepseek.com/v1"
    assert resolved.api_key == "test-key"
    assert resolved.max_tokens == 384000


def test_can_switch_between_deepseek_pro_and_flash_models_from_config():
    config = {
        "default": "deepseek/deepseek-v4-pro",
        "providers": {
            "deepseek": {
                "baseUrl": "https://api.deepseek.com/v1",
                "api": "openai-completions",
                "apiKey": "test-key",
                "family": "deepseek",
                "models": [
                    {"id": "deepseek/deepseek-v4-pro", "maxTokens": 384000},
                    {"id": "deepseek/deepseek-v4-flash", "maxTokens": 384000},
                ],
            }
        },
    }

    pro = analyzer_from_models_config(config, "deepseek/deepseek-v4-pro")
    flash = analyzer_from_models_config(config, "deepseek/deepseek-v4-flash")

    assert isinstance(pro, OpenAICompatibleAnalyzer)
    assert isinstance(flash, OpenAICompatibleAnalyzer)
    assert pro.config.model == "deepseek/deepseek-v4-pro"
    assert flash.config.model == "deepseek/deepseek-v4-flash"


def test_openai_compatible_adapter_posts_chat_completion_request_from_resolved_model():
    calls = []

    def transport(url, headers, payload, timeout_seconds):
        calls.append(
            {
                "url": url,
                "headers": headers,
                "payload": payload,
                "timeout_seconds": timeout_seconds,
            }
        )
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "characters": [
                                    {
                                        "id": "elizabeth",
                                        "canonicalName": "Elizabeth",
                                        "aliases": ["Lizzy"],
                                        "gender": "female",
                                        "ageClass": "adult",
                                        "confidence": 0.94,
                                    }
                                ],
                                "segmentAnnotations": [
                                    {
                                        "segmentIndex": 0,
                                        "speakerId": "elizabeth",
                                        "emotion": "happy",
                                        "confidence": 0.88,
                                        "warnings": [],
                                    }
                                ],
                            }
                        )
                    }
                }
            ]
        }

    analyzer = OpenAICompatibleAnalyzer(
        OpenAICompatibleConfig(
            provider="deepseek",
            api_key="test-key",
            base_url="https://api.deepseek.com/v1",
            model="deepseek/deepseek-v4-pro",
            max_tokens=384000,
        ),
        transport=transport,
    )

    result = analyzer.analyze_chapter(
        ChapterAnalysisRequest(
            book_id="book_123",
            chapter_id="chapter_001",
            text='"Hello," Elizabeth said.',
            language="en",
        )
    )

    assert analyzer.backend_id == "deepseek"
    assert analyzer.supports_real_model is True
    assert calls[0]["url"] == "https://api.deepseek.com/v1/chat/completions"
    assert calls[0]["headers"]["Authorization"] == "Bearer test-key"
    assert calls[0]["payload"]["model"] == "deepseek/deepseek-v4-pro"
    assert calls[0]["payload"]["max_tokens"] == 384000
    assert calls[0]["payload"]["response_format"] == {"type": "json_object"}
    assert result.characters[0].canonical_name == "Elizabeth"
    assert result.segment_annotations[0].emotion == "happy"
