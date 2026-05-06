# 🎙 Audiobook Generator

> Local-first desktop application that turns EPUB and PDF books into
> chapter-narrated audiobooks with character-aware voice casting.

Audiobook Generator runs entirely on your machine: text extraction,
LLM-powered character analysis, dialogue script construction, and
text-to-speech synthesis all happen locally.

## Features

- **Import** EPUB and PDF books (text + OCR for scanned pages)
- **Analyze** characters, dialogue, and narration per chapter via local LLMs
- **Review** detected characters: correct names, genders, and voice assignments
- **Generate** chapter audio with per-character voice synthesis (Parler TTS)
- **Listen** to chapters in-app or export individual `.wav` files

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Tauri desktop shell (Rust)                          │
│  ┌────────────────────────────────────────────────┐  │
│  │  React frontend (TypeScript)                   │  │
│  │  ┌──────────┬──────────┬──────────┬─────────┐  │  │
│  │  │ Import   │ Analyze  │ Review   │ Generate│  │  │
│  │  └──────────┴──────────┴──────────┴─────────┘  │  │
│  │  Sidebar · Step stepper · Progress tracking    │  │
│  └────────────────────────────────────────────────┘  │
│                         │                            │
│  ┌──────────────────────▼─────────────────────────┐  │
│  │  Python worker (subprocess)                    │  │
│  │  extract · rights · analyze · tts · assemble   │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

1. **TypeScript frontend** (React + Tauri) orchestrates the pipeline
2. **Python workers** run as subprocesses for CPU/GPU-heavy tasks:
   - Text extraction from EPUB/PDF via `ebooklib` and `pymupdf`
   - OCR fallback for scanned pages via `pytesseract`
   - LLM character/dialogue analysis via OpenAI-compatible APIs
   - Text-to-speech via `parler-tts` (MPS-accelerated on macOS)
3. **Script IR** — an intermediate JSON format captures chapter scripts
   with characters, voices, emotions, and dialogue segments
4. **All local** — no cloud uploads, no accounts needed

## Quick Start

### Prerequisites

- **Node.js** ≥ 20
- **Python** ≥ 3.12 with `uv` (or pip)
- **Rust** toolchain (for Tauri)
- **macOS** (primary platform; uses MPS acceleration for TTS)

### Setup

```bash
# 1. Install frontend dependencies
npm install

# 2. Install Python worker and dependencies
cd workers/python
uv sync
cd ../..

# 3. (Optional) Configure an LLM provider for analysis
#    Without one, the mock analyzer produces placeholder scripts.
#    See docs below for provider setup.
```

### Run

```bash
cd apps/desktop
npm run tauri dev
```

### Test

```bash
# All tests (TypeScript + Python)
npm test
cd workers/python && uv run pytest
```

## LLM Configuration

Audiobook Generator reads OpenAI-compatible model configuration from:

- `~/.pi/agent/models.json`
- `~/.pi/models.json`

This follows the same provider/model format as `vuln-autoresearcher`.
The default model is `deepseek/deepseek-v4-pro`.

Switch models via environment variable:

```sh
export AUDIOBOOK_LLM_MODEL="deepseek/deepseek-v4-pro"
export AUDIOBOOK_LLM_MODEL="deepseek/deepseek-v4-flash"
```

If no model config is found, the worker falls back to a deterministic mock
analyzer that produces valid but unsophisticated scripts — useful for
testing the TTS pipeline without an API key.

### TTS Configuration

Parler TTS acceleration is controlled via the `AUDIOBOOK_TTS_DEVICE`
environment variable:

```sh
# Auto-detect (recommended default — prefers MPS on macOS)
export AUDIOBOOK_TTS_DEVICE="auto"

# Force macOS GPU acceleration via Metal
export AUDIOBOOK_TTS_DEVICE="mps"

# Force CUDA GPU on Linux/Windows
export AUDIOBOOK_TTS_DEVICE="cuda"

# CPU-only (slow but always works)
export AUDIOBOOK_TTS_DEVICE="cpu"
```

Valid values are `auto`, `mps`, `cuda`, and `cpu`. An invalid value
or an unavailable device (e.g. `mps` on a non-Apple machine) will
raise a clear error at synthesis time.

## Project Structure

```
.
├── apps/desktop/          # Tauri + React desktop app
│   └── src/
│       ├── components/    # React UI components
│       │   └── steps/     # Pipeline step views
│       ├── state/         # Client-side state stores
│       ├── lib/           # Shared utilities
│       └── workers/       # Worker invocation layer
├── packages/shared/       # Shared TypeScript types (script IR)
├── workers/python/        # Python processing workers
│   ├── audiobook_worker/  # Worker modules
│   └── tests/             # Python test suite
├── docs/                  # Design docs, ADRs, plans
│   ├── adr/               # Architecture Decision Records
│   ├── design/            # Design documents
│   └── plans/             # Implementation plans
├── fixtures/books/        # Test fixture books
└── package.json           # Monorepo root
```

## Design Decisions

See [`docs/adr/`](docs/adr/) for Architecture Decision Records covering:

- [0001](docs/adr/0001-local-first-desktop-application.md) — Local-first desktop architecture
- [0002](docs/adr/0002-typescript-orchestration-python-workers.md) — TypeScript orchestration + Python workers
- [0003](docs/adr/0003-script-intermediate-representation.md) — Script intermediate representation
- [0004](docs/adr/0004-confidence-based-review.md) — Confidence-based review workflow
- [0005](docs/adr/0005-license-and-rights-gating.md) — License and rights gating
- [0006](docs/adr/0006-pluggable-local-model-backends.md) — Pluggable local model backends

## Contributing

Contributions are welcome! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for
development setup, testing, and pull request guidelines.

## License

[MIT](LICENSE) © 2026 Audiobook Generator contributors.
