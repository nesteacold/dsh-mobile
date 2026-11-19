# Spec 041 — DSH Extensions Ecosystem Landing Page (`website/`)

**Owner / Lead**: Lead Architect · **Implementation**: `coder` · **Verification**: `reviewer` + automated checks  
**Status**: Approved for implementation · **Location**: `dsh-mobile/website/` (standalone static site; zero workspace-root files; zero WebView wrapping of `apps/web/dist`).

## 1. Goal
Build a self-contained, bilingual (`vi` default + `en` toggle), high-craft static landing page in `dsh-mobile/website/` showcasing the three core extension products built across this workspace (owner correction 2026-11-18: surface groups are not separate products):
1. **DSH Mobile** (one cross-platform remote-control product: Android + iOS native apps, Web PWA, and DSH Desktop Remote via `@dsh-ext/devices` + `@dsh-ext/mobile-gateway`)
2. **Repo Wiki** (`@dsh-ext/dsh-wiki` v0.3.3 — local zero-network DeepWiki-style generator + MCP)
3. **DSH for VS Code** (`dsh-vscode` v0.1.0, in development — ACP v1 native IDE extension)

Visual craft draws inspiration from the deep-ocean liquid-glass architecture (`PRODUCT.md`, `DESIGN.md`), implemented cleanly with our own procedural Ocean Mesh (`Spec 040` grid/dots aesthetic), MIT-licensed `glasswork` v1.1.0 WebGL2 edge refraction + 4-tier `render-budget.js` fallback, and our own verified assets.

## 2. Non-Negotiable Constraints
1. **Zero third-party Whaleness assets**: Do NOT copy or reference any `Whaleness` / `orca` / `whale-girl` / Sketchfab CC-BY mockup renders or third-party app screenshots from `_upstream/` or `plugins/mobile-gateway/docs/assets/`.
2. **Verified-ours assets only**:
   - Copy real DSH Orbit iOS screenshots from `apps/mobile-companion/artifacts/store/ios/` (`02-pairing.png`, `03-session-list.png`, `04-session-detail.png`, `05-approval-card.png`, `06-settings.png`) into `website/assets/screens/`.
   - Copy/include our original SVG marks: `apps/mobile-companion/public/icon.svg` -> `website/assets/orbit-icon.svg`, `dsh-wiki/docs/assets/logo.svg` -> `website/assets/wiki-logo.svg`, `dsh-vscode/extension/resources/icon.svg` -> `website/assets/vscode-icon.svg`.
   - Retain `website/vendor/glasswork/LICENSE` (MIT, Kubai087) if vendoring `glass.css` & `refract.js` from `_upstream/Clarklevis1995__dsh-mobile/website/vendor/glasswork/`.
3. **Truthful product claims only**:
   - Do NOT advertise Cloudflare/public-IP one-command tunnel (hard-disabled in v1), WebRTC/P2P (unreleased), native APNs/FCM push servers, or phone file/photo upload & file browser (design-only in spec 019/030; remote file attach is Desktop Remote only).
   - Label **DSH Orbit** iOS status honestly (Android verified; iOS simulator verified, signed App Store/TestFlight distribution pending) — do not link to fake or third-party TestFlight URLs.
   - Label **DSH for VS Code** clearly as `v0.1.0 · In Development` (`working title`), and clearly mark its interactive UI mock as an architectural preview (inspired by `dsh-vscode/docs/ui-preview.html`), not a released Marketplace build.
   - Clearly document PWA WebCrypto IndexedDB storage & browser-CA TLS trade-offs vs native Keystore/pinning, and `127.0.0.1` loopback default for Gateway & MCP.
4. **Zero external network dependencies & zero telemetry**: No Google Fonts, no external JS/CSS CDNs, no analytics beacons, works cleanly over `http://127.0.0.1` AND degrades cleanly to static CSS when opened via `file://`.
5. **Repo gates must remain green**:
   - `node tools/scan-pii.mjs --worktree` must pass with 0 findings.
   - `node tools/verify-publish.mjs` must pass.
   - Automated website verification script (`website/tests/verify-website.mjs`) checking HTML/CSS/JS syntax, broken local asset/script links, contrast/a11y attributes, zero external URLs in `<script>`/`<link>`, i18n key parity (`vi`/`en`), and `file://` static fallback.

## 3. Page Architecture & Sections
1. **Header (`<header class="header glass">`)**: Brand mark ("DSH Extensions" / "DSH Orbit & Suite"), nav links (`#ecosystem`, `#experience`, `#architecture`, `#setup`, `#faq`), VI/EN language toggle pill, primary CTA (`#setup`). Responsive mobile menu at `<= 1199px`.
2. **Hero**: Eyebrow (`Bộ công cụ mở rộng cho DeepSeek Harness`), bold H1 (`Máy tính chạy tác vụ. Bạn điều khiển từ mọi nơi.`), concise value statement about three products and cross-platform remote control, dual primary CTAs (`Xem 3 bộ công cụ`, `Mô hình bảo mật`), CSS-bezel iPhone render with real status badges (Android/iOS, Web/Desktop, Repo Wiki, VS Code).
3. **Ecosystem Matrix (`#ecosystem`)**: Three product cards matching the three repositories: one full-width featured DSH Mobile card showing Android/iOS/Web/Desktop and six concrete remote-control capabilities, plus two equal half-width cards for Repo Wiki and DSH for VS Code.
4. **Interactive Product Experience (`#experience`, liquid-glass showcase)**: 4 accessible ARIA tabs (`DSH Mobile · Phone & Web`, `DSH Mobile · Desktop Remote`, `Repo Wiki`, `DSH for VS Code`) switching both the structured feature narrative and the live visual stage:
   - Tab 1 (`DSH Mobile · Phone & Web`): interactive screenshot switcher (`Session List`, `Live Conversation`, `argsHash Approval`, `QR Pairing`, `Settings`) using our real iOS screenshots with click-to-zoom lightbox.
   - Tab 2 (`DSH Mobile · Desktop Remote`): interactive multi-host sidebar mock (`This Computer` vs `Remote Workspace` `h:<hostId>`) + pinned WSS, remote file attach and offline retention notes.
   - Tab 3 (`Repo Wiki`): interactive `.dsh-wiki/` preview (Knowledge Cards + `path:line` citation + `wiki_search` / MCP tools + freshness status).
   - Tab 4 (`DSH for VS Code`): interactive ACP chat + split diff approval preview (`v0.1.0 · In Development` badge).
5. **Security & Architecture (`#architecture`)**: Horizontal 3-column flow (`Clients: Mobile / PWA / Remote / VS Code` → `Pinned TLS & Loopback Gateway (127.0.0.1 default)` → `DSH Host & Local Repo`) + 4 concrete non-negotiable guarantees (`No Core Patch`, `Pinned Cert + argsHash`, `Zero Public Relay`, `Zero-Network Repo Wiki`).
6. **Quick Setup Guide (`#setup`)**: Interactive 5-step carousel (`1. Host Gateway`, `2. Pair Mobile / PWA`, `3. Desktop Remote`, `4. Repo Wiki & MCP`, `5. VS Code ACP`) with copy-friendly CLI/config snippets and prev/next/direct-step controls + stable layout height.
7. **FAQ (`#faq`)**: 5 concise, honest technical Q&As (Does it patch DSH core? How do Phone/Web/Desktop differ within DSH Mobile? Is there a cloud relay? Can Repo Wiki data be queried from Claude Code / VS Code? What is the status of DSH for VS Code?).
8. **Footer & Lightbox `<dialog>`**: Attribution (including MIT notice for `glasswork`), zero-telemetry statement, repo layout summary, accessible image lightbox modal.

## 4. Role Assignment
- **Lead**: Created `dsh-vscode/CLAUDE.md`, `website/PRODUCT.md`, `website/DESIGN.md`, and this `specs/041-ecosystem-landing-page/spec.md`.
- **Coder (`coder:assets-and-engine`)**: Copies our verified assets, sets up `website/vendor/glasswork/` (MIT), writes `website/render-budget.js`, `website/ocean-mesh.js`, `website/liquid-glass.css`, `website/liquid-refraction.js`, `website/liquid-glass.js`.
- **Coder (`coder:ui-and-app`)**: Builds `website/index.html`, `website/styles.css`, `website/i18n.js`, `website/main.js`, and `website/tests/verify-website.mjs`.
- **Reviewer (`reviewer:design-and-a11y` & `reviewer:security-and-truth`)**: Independently audits UI craft/responsive/contrast/reduced-motion, truthfulness against source specs, PII/asset provenance, and runs all verification gates.
