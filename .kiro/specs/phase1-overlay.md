# Phase 1 — Background overlay opacity

## Requirement
The background overlay on `body` is currently `rgba(9, 12, 18, 0.68)`, which is
too transparent (the background image shows through too much). Change it to
approximately **0.80** so the image is darker and content contrast improves.

The instruction is: "overlay about 0.80 via one CSS variable, don't touch the
background image."

## Design
- Add a single CSS custom property `--bg-overlay` to `:root`.
- Replace both literal `rgba(9, 12, 18, 0.68)` occurrences in `body`'s
  `background-image` with `rgba(9, 12, 18, var(--bg-overlay))`.
- Set `--bg-overlay: 0.80` in `:root`.
- No other changes to `style.css`, no changes to any other file.

## Files touched
- `public/style.css` only

## Verification
- `npm run lint` — pass
- `npm test` — pass (tests do not assert CSS values; overlay is visual-only)
- `npm run audit` — pass
- `git diff --check -- public/style.css` — pass
- Manual: `npm start`, open `http://localhost:3000`, confirm background is
  darker than before but background image is still faintly visible.

## Task list
- [x] Add `--bg-overlay: 0.80` to `:root`
- [x] Replace `rgba(9, 12, 18, 0.68)` × 2 with `rgba(9, 12, 18, var(--bg-overlay))`
- [x] Run verification suite
- [x] Commit
