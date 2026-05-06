from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal


QUOTE_RE = re.compile(r'["\u201c]([^"\u201d]+)["\u201d]')
SPEECH_VERBS = (
    r"said|asked|replied|whispered|shouted|answered|called|cried|exclaimed|"
    r"observed|remarked|interrupted|declared|protested|murmured|muttered|"
    r"continued|returned|added|laughed|sighed|urged|insisted|repeated|"
    r"began|rejoined|interposed|responded|demanded|inquired"
)
# Pattern 1: "Speaker said" or "Speaker cried"
TRAILING_SPEECH_TAG_RE = re.compile(
    rf"^\s*,?\s*(?P<speaker>(?:Mr\.|Mrs\.|Miss\.|Sir\s+)?[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)?)\s+(?:{SPEECH_VERBS})\b"
)
# Pattern 2a: "said Speaker" — proper name (possibly with title)
TRAILING_SPEECH_TAG_INVERTED_RE = re.compile(
    rf"^\s*,?\s*(?:{SPEECH_VERBS})\s+(?P<speaker>(?:Mr\.|Mrs\.|Miss\.|Sir\s+)?[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)?)"
)
# Pattern 2b: "cried his wife" / "said her sister" — relational noun (lowercase)
TRAILING_SPEECH_TAG_RELATIONAL_RE = re.compile(
    rf"^\s*,?\s*(?:{SPEECH_VERBS})\s+(?:his|her|the)\s+(?P<speaker>[a-z][A-Za-z.'-]*)"
)

SegmentType = Literal["narration", "dialogue"]


@dataclass(frozen=True)
class DialogueSegment:
    type: SegmentType
    text: str
    start_offset: int
    end_offset: int
    speaker_hint: str | None = None
    warnings: list[str] = field(default_factory=list)


def segment_dialogue(text: str) -> list[DialogueSegment]:
    segments: list[DialogueSegment] = []
    cursor = 0
    for match in QUOTE_RE.finditer(text):
        if match.start() > cursor:
            narration = text[cursor : match.start()].strip()
            if narration:
                segments.append(
                    DialogueSegment(
                        type="narration",
                        text=narration,
                        start_offset=cursor,
                        end_offset=match.start(),
                    )
                )

        dialogue_text = match.group(1).strip()
        speaker_hint = _infer_trailing_speaker(text[match.end() :])
        segments.append(
            DialogueSegment(
                type="dialogue",
                text=dialogue_text,
                start_offset=match.start(),
                end_offset=match.end(),
                speaker_hint=speaker_hint,
                warnings=[] if speaker_hint else ["speaker_unknown"],
            )
        )
        cursor = match.end()

    if cursor < len(text):
        narration = text[cursor:].strip()
        if narration:
            segments.append(
                DialogueSegment(
                    type="narration",
                    text=narration,
                    start_offset=cursor,
                    end_offset=len(text),
                )
            )

    return segments or [
        DialogueSegment(
            type="narration",
            text=text.strip(),
            start_offset=0,
            end_offset=len(text),
        )
    ]


def _infer_trailing_speaker(text_after_quote: str) -> str | None:
    for pattern in (
        TRAILING_SPEECH_TAG_RE,
        TRAILING_SPEECH_TAG_INVERTED_RE,
        TRAILING_SPEECH_TAG_RELATIONAL_RE,
    ):
        match = pattern.match(text_after_quote)
        if match:
            return match.group("speaker")
    return None

