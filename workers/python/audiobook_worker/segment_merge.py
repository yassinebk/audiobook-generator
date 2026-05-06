from __future__ import annotations

from copy import deepcopy


def merge_tts_segments(
    segments: list[dict],
    *,
    max_words: int = 80,
) -> list[dict]:
    merged: list[dict] = []

    for segment in segments:
        current = deepcopy(segment)
        current["sourceSegmentIds"] = [segment["id"]]
        current_word_count = len(current.get("text", "").split())

        if not merged:
            current["_wordCount"] = current_word_count
            merged.append(current)
            continue

        previous = merged[-1]
        combined_words = previous["_wordCount"] + current_word_count
        if _can_merge(previous, current) and combined_words <= max_words:
            previous["text"] = " ".join(
                part.strip()
                for part in [previous.get("text", ""), current.get("text", "")]
                if part.strip()
            )
            previous["sourceSegmentIds"].append(current["id"])
            previous["_wordCount"] = combined_words
        else:
            current["_wordCount"] = current_word_count
            merged.append(current)

    for segment in merged:
        segment.pop("_wordCount", None)
    return merged


def _can_merge(left: dict, right: dict) -> bool:
    return (
        left.get("voiceId") == right.get("voiceId")
        and left.get("emotion", "neutral") == right.get("emotion", "neutral")
        and left.get("pace", "normal") == right.get("pace", "normal")
    )
