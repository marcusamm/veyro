"""Turn OCR boxes into reading-order text without inventing receipt values.

Two spaces delimit visibly separate columns, as expected by Veyro's receipt
reader. Adjacent fragments within one cell receive one space. This heuristic
does not promise to recover every receipt layout; every result needs review.
"""

import math
import re
from dataclasses import dataclass
from statistics import median
from typing import Any

from limits import InvalidDocument, MAX_TEXT_CHARS


@dataclass(frozen=True)
class TextBox:
    text: str
    left: float
    top: float
    right: float
    bottom: float

    @property
    def height(self) -> float:
        return self.bottom - self.top

    @property
    def middle(self) -> float:
        return (self.bottom + self.top) / 2


def text_boxes(result: Any) -> list[TextBox]:
    """Read the documented PaddleOCR 3.x rec_texts/rec_polys result fields."""
    texts = result.get("rec_texts", [])
    polys = result.get("rec_polys", [])
    if len(texts) != len(polys) or len(texts) > 6000:
        raise InvalidDocument("Invalid OCR geometry")
    out = []
    word_regions = result.get("text_word_region", [])
    word_texts = result.get("text_word", [])
    for index, (text, poly) in enumerate(zip(texts, polys)):
        if not isinstance(text, str):
            raise InvalidDocument("Invalid OCR text")
        # Never preserve embedded control codes or accidental column whitespace.
        clean = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", text)).strip()
        if not clean:
            continue
        if len(clean) > 4000 or len(poly) != 4:
            raise InvalidDocument("Invalid OCR region")
        coordinates = [(float(point[0]), float(point[1])) for point in poly]
        # Detector boxes include padding. Tighten them using CTC word geometry
        # while retaining the original complete text, punctuation and decimals.
        # Otherwise nearby headings such as "Enhed" and "Pris" can look joined.
        if len(word_regions) == len(texts) and len(word_texts) == len(texts):
            regions, words = word_regions[index], word_texts[index]
            if len(regions) != len(words):
                raise InvalidDocument("Invalid OCR word geometry")
            tight = []
            for word, region in zip(words, regions):
                if not isinstance(word, str) or len(region) != 4:
                    raise InvalidDocument("Invalid OCR word region")
                if word.strip():
                    tight.extend((float(point[0]), float(point[1])) for point in region)
            if tight:
                coordinates = tight
        if not all(math.isfinite(n) and 0 <= n <= 100_000 for xy in coordinates for n in xy):
            raise InvalidDocument("Invalid OCR coordinates")
        xs, ys = zip(*coordinates)
        box = TextBox(clean, min(xs), min(ys), max(xs), max(ys))
        if box.height > 0 and box.right > box.left:
            out.append(box)
    return out


def reconstruct_rows(boxes: list[TextBox]) -> str:
    if not boxes:
        return ""
    rows: list[list[TextBox]] = []
    for box in sorted(boxes, key=lambda b: (b.middle, b.left)):
        row = next((r for r in reversed(rows[-4:]) if abs(median(b.middle for b in r) - box.middle) <= min(median(b.height for b in r), box.height) * 0.45), None)
        if row is None:
            rows.append([box])
        else:
            row.append(box)
    lines = []
    length = 0
    for row in sorted(rows, key=lambda r: median(b.middle for b in r)):
        row.sort(key=lambda b: b.left)
        # Box width per character is useful for mixed font sizes. Cap the gap
        # threshold so long descriptions do not merge numeric table columns.
        char_width = median((b.right - b.left) / max(len(b.text), 1) for b in row)
        split_gap = max(8.0, min(median(b.height for b in row) * 0.8, char_width * 2.1))
        parts = [row[0].text]
        for previous, current in zip(row, row[1:]):
            parts.append(("  " if current.left - previous.right >= split_gap else " ") + current.text)
        line = "".join(parts)
        length += len(line) + 1
        if length > MAX_TEXT_CHARS:
            raise InvalidDocument("OCR text exceeds limit")
        lines.append(line)
    return "\n".join(lines)

