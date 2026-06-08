# PRism canonical icons

Source artwork for the PRism logo: a full-bleed purple **squircle** (rounded
corners, transparent outside the curve) with the white prism mark. The same
squircle shape ships on every surface — derivation is pure downscale, no
per-platform masking or padding.

## Single source of truth

`PRismOG.png` is the **only** file you edit by hand. Everything else —
the desktop app icons, the web favicon/logo, and the multi-resolution `.ico`
packs — is regenerated from it by `generate-icons.py`.

| File                             | Size           | Description                                                                                                   |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `PRismOG.png`                    | square, ≥512px | Canonical PNG master (full-bleed squircle, transparent corners; exact pixel size varies per refresh)          |
| `PRism{16,32,48,64,256,512}.ico` | multi-res      | Identical multi-resolution packs (16/24/32/48/64/128/256); only the filename differs — kept for compatibility |
| `PRismOG.ico`                    | multi-res      | Same multi-resolution pack as the above                                                                       |

> ICO directory entries cap at 256px, so the `.ico` packs top out at 256 even
> though the master is larger.

## Derived copies (regenerated, do not hand-edit)

| Derived path                     | Source        | Transform                                                    |
| -------------------------------- | ------------- | ------------------------------------------------------------ |
| `frontend/public/prism-logo.png` | `PRismOG.png` | resize 256×256                                               |
| `frontend/public/favicon.png`    | `PRismOG.png` | resize 32×32                                                 |
| `desktop/assets/icon.ico`        | `PRismOG.png` | multi-res `.ico` (Windows window/taskbar + electron-builder) |
| `desktop/assets/icon.icns`       | `PRismOG.png` | `.icns` (macOS dock, packaged by electron-builder)           |

`PRism.Web/wwwroot/{favicon.png,prism-logo.png}` are **build artifacts** copied
from the frontend build — not tracked, not written by the generator.

The web copies are deliberately downscaled, not raw copies of the master: a
naive `cp` of the full-resolution artwork produced ~1.8 MB of inline image data
per page load, which blocked Vite's HMR + Playwright's `page.goto` `load` event.
See `docs/specs/2026-05-15-s6-polish-and-distribution-deferrals.md`.

## Re-deriving after a canonical-icon change

1. Replace `assets/icons/PRismOG.png` with the new full-bleed squircle artwork
   (square, transparent corners, ≥512×512; the master is the only edit).
2. Run the generator from the repo root:

   ```sh
   python assets/icons/generate-icons.py
   ```

3. Rebuild the frontend so `PRism.Web/wwwroot` picks up the new web copies.

`generate-icons.py` requires Pillow, which is **not** a project dependency.
Install it ad-hoc: `pip install --user Pillow`.
