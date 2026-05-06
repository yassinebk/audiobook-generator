# Contributing to Audiobook Generator

Thanks for your interest in contributing!

## Getting Started

### Prerequisites

- Node.js ≥ 20
- Python ≥ 3.12
- Rust toolchain (for Tauri)
- macOS (primary dev platform; Linux and Windows may work with adjustments)

### Setup

```bash
# Clone and install
git clone https://github.com/<org>/audiobook-generator.git
cd audiobook-generator

# Frontend
npm install

# Python worker
cd workers/python
uv sync --all-extras
cd ../..
```

### Running the App

```bash
cd apps/desktop
npm run tauri dev
```

The Tauri dev server starts a Vite HMR frontend and spawns a native window.

### Running Tests

```bash
# TypeScript tests (all workspaces)
npm test

# Python tests
cd workers/python && uv run pytest
```

## Development Workflow

### Code Style

- **TypeScript**: Follow the existing patterns — functional React components,
  TypeScript strict mode, `useCallback`/`useState` hooks.
- **Python**: PEP 8, type hints encouraged, `pytest` for tests.

### File Organization

- UI components go in `apps/desktop/src/components/`
- Pipeline step views in `apps/desktop/src/components/steps/`
- State stores in `apps/desktop/src/state/`
- Worker orchestration in `apps/desktop/src/workers/`
- Types shared between frontend and worker in `packages/shared/src/`
- Python business logic in `workers/python/audiobook_worker/`

### Making Changes

1. Create a branch from `main`
2. Make your changes
3. Add tests that cover your changes
4. Run `npm test` and `cd workers/python && uv run pytest`
5. Open a pull request

### Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat: add EPUB metadata extraction
fix: handle empty chapter titles in analysis
docs: document TTS backend configuration
test: add dialogue segmenter edge case tests
```

## Architecture Notes

- The desktop app spawns the Python worker as a subprocess via Tauri's
  `Command` API. Worker calls are JSON-in/JSON-out.
- The shared `packages/shared` workspace defines the script IR schema — this
  is the contract between the TypeScript frontend and Python workers.
- LLM analysis uses an OpenAI-compatible API. The worker discovers model
  configuration from `~/.pi/agent/models.json` or `~/.pi/models.json`.

## Questions?

Open an issue or start a discussion.
