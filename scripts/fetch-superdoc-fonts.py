#!/usr/bin/env python3
"""Fetch the SuperDoc editor's fonts into assets/superdoc-fonts/ (committed).

Run by hand when the font list in src/superdoc/fonts.ts changes:
    python3 scripts/fetch-superdoc-fonts.py

Why not @fontsource-variable: it ships each font split into unicode-range
subsets (latin, latin-ext, ...), and SuperDoc registers ONE face per
family/weight/style — a second subset file for the same face is rejected
("a registered face's source cannot be replaced"). So the latin-ext half,
which carries Romanian ă ș ț, never loaded.

This downloads each family's full variable font from the google/fonts repo
(SIL OFL — redistributable), trims it to Latin + Latin Extended while keeping
every axis and OpenType feature, and writes one woff2 per style, plus the
licence. Needs fontTools and brotli (pip install fonttools brotli).
"""
import io
import pathlib
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

OUT = pathlib.Path(__file__).resolve().parent.parent / "assets" / "superdoc-fonts"
RAW = "https://raw.githubusercontent.com/google/fonts/main/ofl"

# slug (matches src/superdoc/fonts.ts) -> (google/fonts dir, upright file, italic file)
FONTS = {
    "fraunces": ("fraunces", "Fraunces[SOFT,WONK,opsz,wght].ttf", "Fraunces-Italic[SOFT,WONK,opsz,wght].ttf"),
    "newsreader": ("newsreader", "Newsreader[opsz,wght].ttf", "Newsreader-Italic[opsz,wght].ttf"),
    "lora": ("lora", "Lora[wght].ttf", "Lora-Italic[wght].ttf"),
    "source-serif-4": ("sourceserif4", "SourceSerif4[opsz,wght].ttf", "SourceSerif4-Italic[opsz,wght].ttf"),
    "quicksand": ("quicksand", "Quicksand[wght].ttf", None),
    "space-grotesk": ("spacegrotesk", "SpaceGrotesk[wght].ttf", None),
    "inter": ("inter", "Inter[opsz,wght].ttf", "Inter-Italic[opsz,wght].ttf"),
    "work-sans": ("worksans", "WorkSans[wght].ttf", "WorkSans-Italic[wght].ttf"),
    "manrope": ("manrope", "Manrope[wght].ttf", None),
    "geist-mono": ("geistmono", "GeistMono[wght].ttf", "GeistMono-Italic[wght].ttf"),
    "jetbrains-mono": ("jetbrainsmono", "JetBrainsMono[wght].ttf", "JetBrainsMono-Italic[wght].ttf"),
}

# Latin + Latin Extended (the two @fontsource subsets Folio needs), as ranges.
UNICODES = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,"
    "U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+21D2,U+2191,U+2193,U+2212,U+2215,"
    "U+FEFF,U+FFFD,U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,"
    "U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,"
    "U+2C60-2C7F,U+A720-A7FF"
)


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def to_woff2(ttf: bytes, dest: pathlib.Path) -> None:
    font = TTFont(io.BytesIO(ttf))
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]  # keep ligatures, kerning, alternates
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    font.flavor = "woff2"
    font.save(dest)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for slug, (folder, upright, italic) in FONTS.items():
        for style, name in (("normal", upright), ("italic", italic)):
            if not name:
                continue
            dest = OUT / f"{slug}-{style}.woff2"
            to_woff2(fetch(f"{RAW}/{folder}/{urllib.request.quote(name)}"), dest)
            print(f"{dest.name}: {dest.stat().st_size // 1024} KB")
        (OUT / f"{slug}-OFL.txt").write_bytes(fetch(f"{RAW}/{folder}/OFL.txt"))


if __name__ == "__main__":
    main()
