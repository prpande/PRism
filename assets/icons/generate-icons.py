#!/usr/bin/env python3
"""Regenerate every derived PRism icon from the canonical master.

Single source of truth: ``assets/icons/PRismOG.png``. Everything else in the
repo (Windows/macOS desktop icons, web favicon, in-app logo, and the
multi-resolution .ico source packs) is derived from it by this script, so a
brand refresh is: drop new artwork at PRismOG.png, run this, commit.

The master is a full-bleed squircle with transparent corners; derivation is
pure downscale (LANCZOS) with no masking or padding, so the same shape ships
on every surface.

Usage (from repo root or anywhere):
    python assets/icons/generate-icons.py

Requires Pillow (not a project dependency): ``pip install --user Pillow``.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

# Repo root is two levels up from assets/icons/.
ROOT = Path(__file__).resolve().parents[2]
MASTER = ROOT / "assets" / "icons" / "PRismOG.png"

# ICO directory entries cap at 256px; embedding larger is non-standard.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
# Apple .icns slots. 1024 is the macOS Retina slot; write_icns drops any slot
# larger than the master, so a smaller master degrades gracefully instead of
# being upscaled (the exact master size varies per refresh).
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]


def load_master() -> Image.Image:
    im = Image.open(MASTER).convert("RGBA")
    print(f"master: {MASTER.relative_to(ROOT)} {im.size[0]}x{im.size[1]}")
    return im


def resized(master: Image.Image, size: int) -> Image.Image:
    return master.resize((size, size), Image.LANCZOS)


def write_png(master: Image.Image, rel: str, size: int, palette: bool = False) -> None:
    out = ROOT / rel
    img = resized(master, size)
    if palette:
        # Quantize to a palette PNG (FASTOCTREE keeps the alpha channel) so the
        # in-app logo stays small — it loads on the cold-start / loading path.
        # The artwork is near-flat (purple + white), so 256 colors is lossless
        # in practice. The 32px favicon is already tiny, so it stays RGBA.
        img = img.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
    img.save(out, optimize=True)
    print(f"  png  {rel} ({size}x{size}{', palette' if palette else ''})")


def write_ico(master: Image.Image, rel: str, sizes: list[int]) -> None:
    out = ROOT / rel
    # Pillow builds a multi-resolution .ico from the base image + sizes list.
    master.save(out, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"  ico  {rel} ({'/'.join(map(str, sizes))})")


def write_icns(master: Image.Image, rel: str, sizes: list[int]) -> None:
    out = ROOT / rel
    # Drop any slot larger than the master so we never upscale; a smaller master
    # simply omits the bigger slots (e.g. a 512px master skips 1024).
    sizes = [s for s in sizes if s <= master.width]
    biggest = resized(master, max(sizes))
    biggest.save(out, format="ICNS", sizes=[(s, s) for s in sizes])
    print(f"  icns {rel} ({'/'.join(map(str, sizes))})")


def main() -> None:
    master = load_master()

    # Web-app derived copies (frontend/public/* — backend wwwroot is a build
    # artifact copied from the frontend build, so it is NOT written here).
    write_png(master, "frontend/public/prism-logo.png", 256, palette=True)
    write_png(master, "frontend/public/favicon.png", 32)

    # Desktop app icons consumed by electron-builder / BrowserWindow.icon.
    write_ico(master, "desktop/assets/icon.ico", ICO_SIZES)
    write_icns(master, "desktop/assets/icon.icns", ICNS_SIZES)

    # Canonical multi-resolution source packs. Historically six files with
    # identical contents differing only by filename; preserved for compatibility.
    for name in ("PRism16", "PRism32", "PRism48", "PRism64", "PRism256", "PRism512"):
        write_ico(master, f"assets/icons/{name}.ico", ICO_SIZES)
    write_ico(master, "assets/icons/PRismOG.ico", ICO_SIZES)

    print("done.")


if __name__ == "__main__":
    main()
