"""Bounded re-reading of columns which a detector merged into one text region.

This uses visible blank gutters in the source pixels, never receipt vocabulary
or guessed character boundaries. For example, OCR may return "EnhedPris" even
though the page has a wide blank gutter between those two headings.
"""

import math
from typing import Callable

import cv2
import numpy as np

from layout import TextBox, reconstruct_rows, text_boxes
from limits import InvalidDocument

MAX_REFINEMENT_CROPS = 32


def ink_segments(image: np.ndarray, minimum_gap: int) -> list[tuple[int, int]]:
    """Return ink-bearing x intervals separated by a genuinely blank gutter."""
    if image.size == 0:
        return []
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # Use the border to distinguish a light receipt from reversed light text.
    border = np.concatenate((gray[0], gray[-1], gray[:, 0], gray[:, -1]))
    inverse = np.median(border) >= 127
    _, ink = cv2.threshold(gray, 0, 255, (cv2.THRESH_BINARY_INV if inverse else cv2.THRESH_BINARY) | cv2.THRESH_OTSU)
    occupied = np.flatnonzero(np.count_nonzero(ink, axis=0) >= max(1, image.shape[0] // 20))
    if len(occupied) == 0:
        return []
    cuts = np.flatnonzero(np.diff(occupied) > minimum_gap)
    intervals = []
    first = 0
    for cut in [*cuts, len(occupied) - 1]:
        intervals.append((int(occupied[first]), int(occupied[cut]) + 1))
        first = int(cut) + 1
    return intervals


def refine_columns(image: np.ndarray, result, recognize: Callable) -> list[TextBox]:
    """Re-OCR only merged visual columns, retaining original-page geometry."""
    boxes = text_boxes(result)
    height, width = image.shape[:2]
    output = []
    used = 0
    for box in boxes:
        if box.right - box.left < 4 * box.height:
            output.append(box)
            continue
        margin = max(5, math.ceil(box.height * 0.3))
        left = max(0, math.floor(box.left) - margin)
        right = min(width, math.ceil(box.right) + margin)
        top = max(0, math.floor(box.top) - 2)
        bottom = min(height, math.ceil(box.bottom) + 2)
        region = image[top:bottom, left:right]
        segments = ink_segments(region, max(18, math.ceil(box.height * 0.75)))
        # Expanded region margins can contain a neighbour's last character. Its
        # centre lies outside the recognized region and must not be duplicated.
        segments = [(a, b) for a, b in segments if box.left <= left + (a + b) / 2 <= box.right]
        if len(segments) < 2:
            output.append(box)
            continue
        used += len(segments)
        if used > MAX_REFINEMENT_CROPS:
            raise InvalidDocument("Too many ambiguous OCR columns")
        for start, end in segments:
            crop_left = max(0, left + start - 4)
            crop_right = min(width, left + end + 4)
            crop = image[top:bottom, crop_left:crop_right]
            border_color = tuple(int(v) for v in np.median(crop.reshape(-1, 3), axis=0))
            crop = cv2.copyMakeBorder(crop, 8, 8, 8, 8, cv2.BORDER_CONSTANT, value=border_color)
            scale = max(1.0, min(3.0, 80 / crop.shape[0]))
            if scale > 1:
                crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            reread = list(recognize(crop))
            if len(reread) != 1:
                raise InvalidDocument("Ambiguous OCR column result")
            text = reconstruct_rows(text_boxes(reread[0]))
            if not text or "\n" in text:
                raise InvalidDocument("OCR column could not be read")
            output.append(TextBox(text, left + start, box.top, left + end, box.bottom))
    return output
