# PRism canonical icons

Source artwork for the PRism logo. PNG and ICO formats at multiple resolutions.

| File | Size | Description |
|---|---|---|
| `PRismOG.png` | 1024×1024 | Canonical PNG source (1.3 MB) |
| `PRismOG.ico` | 1135×1135 | Single-resolution ICO source (1.9 MB) |
| `PRism{16,32,48,64,256,512}.ico` | multi-res | All six contain identical 6-icon packs (16/32/48/64/256/512); only the filename differs (~535 KB each) |

## Web-app derived copies

The frontend ships **derived, web-optimized** copies under `frontend/public/`:

| Derived path | Source | Transform | Size |
|---|---|---|---|
| `frontend/public/prism-logo.png` | `assets/icons/PRismOG.png` | resize 256×256, PNG palette mode | ~22 KB |
| `frontend/public/favicon.png` | `assets/icons/PRismOG.png` | resize 32×32, PNG | ~3 KB |

The naive `cp` originally prescribed in `docs/specs/2026-05-15-s6-polish-and-distribution-design.md` § 5.1 produced 1.84 MB of inline image data per page load, which blocked Vite's HMR + Playwright's `page.goto` `load` event. Web copies MUST be the derived versions, not raw copies of the canonical icons. See `docs/specs/2026-05-15-s6-polish-and-distribution-deferrals.md` for the deferral entry.

## Re-deriving after a canonical-icon change

From `frontend/`:

```sh
node -e "
require('sharp')('../assets/icons/PRismOG.png')
  .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9, palette: true })
  .toFile('public/prism-logo.png');
"
node -e "
require('sharp')('../assets/icons/PRismOG.png')
  .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toFile('public/favicon.png');
"
```

`sharp` is not a project dependency. Install ad-hoc: `npm install --no-save sharp`.
