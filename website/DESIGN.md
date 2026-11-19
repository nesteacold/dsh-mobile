# DESIGN.md — DSH Ecosystem Landing Page

## Aesthetic Direction
- **Theme**: Deep-ocean technical glass — dark-only (`color-scheme: dark`), calm, authoritative, engineered rather than decorative.
- **Visual Anchor**: Real DSH Orbit iOS screenshots (`assets/screens/*.png`) framed in crisp CSS hardware bezels alongside interactive desktop/IDE previews and our three original product SVG marks (`orbit-icon.svg`, `wiki-logo.svg`, `vscode-icon.svg`).
- **Owner Constraint (from Spec 040)**: **No whale silhouette / mascot / Whaleness branding.** Use DSH Orbit's geometric ocean mesh, technical grid, and liquid-glass surface layers.

## Color Tokens
Aligned directly with `apps/mobile-companion/src/ui/theme.ts` (`brand` + `darkColors`) and deep-ocean contrast discipline:
- `--bg`: `#030d1c` (deep abyss base)
- `--bg-navy`: `#06172B` (DSH Orbit `brand.navy`)
- `--surface`: `#081e32`
- `--surface-raised`: `#0D2440` (`brand.navyRaised`)
- `--surface-soft`: `#0b2941`
- `--text`: `#edf7ff` (primary high-contrast ink)
- `--muted`: `#bad0e3` (>= 7:1 contrast on `#081e32`)
- `--subtle`: `#98b6cf` (>= 4.5:1 contrast for captions/footnotes)
- `--line`: `#25445d`
- `--accent`: `#a1ddff` (ice highlight for display accents & primary buttons)
- `--accent-hover`: `#caedff`
- `--accent-ocean`: `#2E6BE6` (DSH Orbit `brand.ocean` for active interactive badges/rings)
- `--accent-teal`: `#5eead4` (Repo Wiki / VS Code secondary technical indicator)
- `--success`: `#2EB85C`

## Typography & Scale
- System UI + CJK-safe stack: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "PingFang SC", "Noto Sans", sans-serif` (zero external font CDNs).
- Monospace: `ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace`.
- Display H1: `clamp(40px, 5.2vw, 72px)`, weight `700`, tracking `-0.04em`, line-height `1.12`.
- Section H2: `clamp(30px, 3.8vw, 46px)`, weight `650`, tracking `-0.035em`, line-height `1.22`.
- Subsection H3: `clamp(18px, 2.4vw, 24px)` for cards/items (`clamp(22px, 2.4vw, 30px)` for stage headings), weight `650`.
- Body: `16px–17px`, line-height `1.7`, max measure `62ch`.

## Layout, Rhythm & Density
- Max container width: `1200px`, side gutter `48px` desktop / `16px` mobile (`<= 767px`).
- Section vertical rhythm: `96px` desktop / `64px` mobile.
- Surface radius: `20px` for major glass cards, `14px` for nested panels, `999px` for pill buttons & chips.
- **Hero Stage**:
  - Do NOT draw a synthetic CSS Dynamic Island notch over screenshots (`assets/screens/*.png` already include the native iOS Dynamic Island and status bar).
  - Do NOT float status pills across the phone screen face; keep the iPhone bezel completely unobstructed and render product status chips in a clean strip beneath the device frame.
  - Avoid repeating the H1 headline inside the lead paragraph.
- **Ecosystem Grid (`#ecosystem`)**:
  - Present the **3 core products** (1-to-1 with `dsh-mobile`, `dsh-wiki`, `dsh-vscode`):
    - Featured full-width flagship card on top (`grid-column: 1 / -1`): **DSH Mobile** (showing its 4 target platforms side-by-side: **Android · iOS · Web App · Desktop Remote** and its unified remote-control features).
    - Two equal cards below (`grid-column: span 3` each on a 6-column grid): **Repo Wiki (`dsh-wiki`)** and **DSH for VS Code (`dsh-vscode`)**.
- **Mobile Header (`<= 767px`)**:
  - Hide the header CTA button inside `.header-actions` on narrow viewports (keep brand, `VI/EN` toggle, and menu button; include the `#setup` CTA inside `#mobile-nav`) so `320px–390px` viewports and high-DPI scaled mobile screens never clip horizontally.
- **Anti-slop rules**:
  - Do NOT wrap every small bullet in nested boxes with generic icon tiles above every heading.
  - Keep glass lens refraction (`data-glass-lens`) strictly on primary `.glass` card containers (`.product-card`, `.showcase`, `.setup-shell`) — never on unstyled layout wrappers like `.hero-visual` or sticky `.header`.
  - Zero horizontal overflow at `320px`, `360px`, and `390px` viewports (`overflow-x: clip` on sections with radial glows).

## Motion, Rendering & Accessibility Budget
- **Procedural Ocean Mesh** (`ocean-mesh.js`): renders deep-navy gradient, subtle `42px` technical grid, sparse lit nodes `(row*11 + col*7) % 13 == 0` (matching Spec 040), and soft caustic glow — **no third-party generated images**.
- **Glasswork WebGL2 Refraction** (`vendor/glasswork/` MIT + `liquid-refraction.js`): edge-only refraction on visible viewport cards (`maxSurfaces: 8`, low-power context, zero `antialias`/`depth`/`stencil`).
- **Four-tier Render Budget** (`render-budget.js`): `full` (24fps) → `balanced` (18fps) → `low` (12fps, no WebGL) → `static` (CSS-only ocean mesh, zero canvas loop). Auto-downgrades on sustained slow frames (`>=24` samples over `1.8s`), low RAM/CPU (`<=2GB` or `<=2 cores`), `saveData`, `prefers-reduced-motion`, `prefers-reduced-transparency`, `forced-colors`, or `file://` origin.
- **A11y**: skip link, visible `3px` `:focus-visible` ring, semantic landmarks, full keyboard `ArrowLeft`/`ArrowRight`/`Home`/`End` navigation on tabs, accessible `<dialog>` lightbox with focus restoration, `aria-expanded` on accordions and mobile drawer.
