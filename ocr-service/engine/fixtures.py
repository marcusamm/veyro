"""Clearly fictitious raster receipt for repeatable smoke tests; no real data."""

import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def receipt_image(font_path: str | None = None) -> Image.Image:
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    path = font_path if font_path is not None else next((p for p in paths if Path(p).is_file()), None)
    if path is None:
        raise RuntimeError("Smoke test needs DejaVu Sans or Arial")
    font = ImageFont.truetype(path, 32)
    title = ImageFont.truetype(path, 44)
    image = Image.new("RGB", (1500, 1000), "white")
    draw = ImageDraw.Draw(image)
    draw.text((60, 50), "TESTDATA BYGGEMARKED", fill="black", font=title)
    draw.text((60, 120), "Fiktivt bilag - ingen handel", fill="black", font=font)
    draw.text((60, 175), "Dato: 29.10.2026", fill="black", font=font)
    columns = [60, 680, 820, 970, 1200]
    for y, row in [
        (300, ["Vare", "Antal", "Enhed", "Pris", "Beløb"]),
        (370, ["Skruer 5 x 80 mm", "2", "pk.", "125,00", "250,00"]),
        (440, ["Fugemasse hvid", "3", "stk.", "40,00", "120,00"]),
    ]:
        for x, value in zip(columns, row):
            draw.text((x, y), value, fill="black", font=font)
    for y, label, value in [
        (600, "Netto", "370,00"),
        (670, "Moms 25 %", "92,50"),
        (740, "Total DKK", "462,50"),
    ]:
        draw.text((60, y), label, fill="black", font=font)
        draw.text((1200, y), value, fill="black", font=font)
    return image


def receipt_bytes(format: str = "PNG", font_path: str | None = None) -> bytes:
    with receipt_image(font_path) as image:
        buffer = io.BytesIO()
        image.save(buffer, format=format)
        return buffer.getvalue()

