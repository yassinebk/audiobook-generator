# Audiobook Generator

Local-first desktop app for generating chapter-based audiobooks from PDF and EPUB files.

## LLM analysis

The Python worker reads OpenAI-compatible model configuration from:

- `~/.pi/agent/models.json`
- `~/.pi/models.json`

This follows the same provider/model format used by `vuln-autoresearcher`.
With a config whose default is `deepseek/deepseek-v4-pro`, audiobook analysis uses
DeepSeek through the configured `baseUrl`, `apiKey` or `apiKeyEnv`, and model id.

Switch between DeepSeek Pro and Flash with:

```sh
export AUDIOBOOK_LLM_MODEL="deepseek/deepseek-v4-pro"
export AUDIOBOOK_LLM_MODEL="deepseek/deepseek-v4-flash"
```

If no model config is found, the worker falls back to its deterministic mock analyzer.
