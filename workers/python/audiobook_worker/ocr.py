from __future__ import annotations

from pathlib import Path
from typing import Literal

import fitz

PDFTextLayerClassification = Literal["selectable_text", "scanned", "mixed"]


class OCRBackendNotConfigured(RuntimeError):
    code = "ocr_backend_not_configured"


def classify_pdf_text_layer(input_path: Path | str) -> PDFTextLayerClassification:
    document = fitz.open(Path(input_path))
    try:
        page_count = document.page_count
        pages_with_text = 0
        for page in document:
            if page.get_text("text").strip():
                pages_with_text += 1
    finally:
        document.close()

    if pages_with_text == 0:
        return "scanned"
    if pages_with_text < page_count:
        return "mixed"
    return "selectable_text"


def run_ocr(input_path: Path | str) -> str:
    raise OCRBackendNotConfigured(
        f"OCR backend is not configured for {Path(input_path).name}"
    )

