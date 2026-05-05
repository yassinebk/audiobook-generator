from audiobook_worker.chapters import detect_chapters


def test_detects_arabic_number_chapter_headings():
    text = """Chapter 1
The first room was quiet.

Chapter 2
The second room was loud."""

    chapters = detect_chapters(text)

    assert [chapter.title for chapter in chapters] == ["Chapter 1", "Chapter 2"]
    assert chapters[0].text == "The first room was quiet."
    assert chapters[1].text == "The second room was loud."


def test_detects_roman_number_chapter_headings():
    text = """CHAPTER II
Elizabeth listened.

CHAPTER III
Darcy answered."""

    chapters = detect_chapters(text)

    assert [chapter.title for chapter in chapters] == ["CHAPTER II", "CHAPTER III"]


def test_returns_single_chapter_when_no_heading_is_found():
    text = "A short story without an explicit chapter heading."

    chapters = detect_chapters(text)

    assert len(chapters) == 1
    assert chapters[0].id == "chapter_001"
    assert chapters[0].title == "Chapter 1"
    assert chapters[0].confidence == 0.35

