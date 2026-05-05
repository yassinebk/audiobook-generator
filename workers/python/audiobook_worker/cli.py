from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _response(
    status: str,
    *,
    warnings: list[str] | None = None,
    artifacts: list[dict[str, Any]] | None = None,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": status,
        "warnings": warnings or [],
        "artifacts": artifacts or [],
    }
    if error is not None:
        payload["error"] = error
    return payload


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="audiobook-worker",
        description="Run local audiobook processing worker commands.",
    )
    parser.add_argument("command", nargs="?", help="worker command to run")
    parser.add_argument("input_path", nargs="?", help="path to JSON worker input")
    parser.add_argument("output_path", nargs="?", help="path to write JSON worker output")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    if args.input_path is None or args.output_path is None:
        parser.error("command requires input_path and output_path")

    output_path = Path(args.output_path)
    payload = _response(
        "failed",
        error={
            "code": "unknown_command",
            "message": f"Unknown worker command: {args.command}",
        },
    )
    _write_json(output_path, payload)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

