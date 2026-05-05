from pathlib import Path

import fitz

from audiobook_worker.extract import extract_book_text
from audiobook_worker.ocr import OCRBackendNotConfigured, classify_pdf_text_layer, run_ocr


def write_blank_pdf(path: Path) -> None:
    document = fitz.open()
    document.new_page()
    document.save(path)
    document.close()


def write_mixed_pdf(path: Path) -> None:
    document = fitz.open()
    first = document.new_page()
    first.insert_text((72, 72), "This page has selectable text.")
    document.new_page()
    document.save(path)
    document.close()


def test_blank_pdf_is_classified_as_scanned(tmp_path: Path):
    input_path = tmp_path / "blank.pdf"
    write_blank_pdf(input_path)

    classification = classify_pdf_text_layer(input_path)
    extracted = extract_book_text(input_path)

    assert classification == "scanned"
    assert extracted.requires_ocr is True
    assert "requires_ocr" in extracted.warnings


def test_mixed_pdf_is_classified_as_mixed(tmp_path: Path):
    input_path = tmp_path / "mixed.pdf"
    write_mixed_pdf(input_path)

    assert classify_pdf_text_layer(input_path) == "mixed"


def test_placeholder_ocr_backend_returns_clear_error(tmp_path: Path):
    input_path = tmp_path / "blank.pdf"
    write_blank_pdf(input_path)

    try:
        run_ocr(input_path)
    except OCRBackendNotConfigured as error:
        assert error.code == "ocr_backend_not_configured"
        assert "OCR backend is not configured" in str(error)
    else:
        raise AssertionError("run_ocr should fail until an OCR backend is configured")

