# 049 — PWA fixed dark contrast for header and composer

Status: **proposed**. UI-only; no auth/wire change. Supersedes the scheme-derived approach in 047/048
for the web session screen.

Owner screenshots 2026-11-19 (iPhone PWA) still show:
- header metadata (“http agent idle”) bleeding through the floating header;
- composer text near-white on a light gray capsule.

The scheme-derived `composerPalette(theme.scheme)` and `glassSolid` are not reliable on iOS Safari
PWA: the browser can report/render a different scheme from the glass surface. Do not infer contrast
from `useColorScheme()` on web for these two chrome surfaces.

## Decision

On **web only**, use an explicit fixed dark pair for the session header and composer:

```text
surface  #0B1220
text     #F1F4FA
muted    #C7CEDA
faint    #9AA7B8
border   #5E6B82
```

- Header web background is opaque `#0B1220`; title, host/status/preset text and icons use the fixed
  light tokens. Native keeps its existing translucent paper header.
- Composer capsule background/border, TextInput text/placeholder, reply quote and model pill label
  use the fixed tokens. Pass an optional palette override into `ComposerModelRow` instead of reading
  the theme there.
- Do not change transcript/message bubble colors, native screens, auth, or wire frames.

## Tests

- Pure helper returns the fixed palette on web and the theme palette on native.
- Web composition test: header background opaque, title text light, composer surface dark, typed text
  light, placeholder muted, model pill label light on dark.
- Existing contrast/theme fallback tests still pass.

## Acceptance

iPhone PWA shows white text on a dark header/composer (or, if a future owner chooses, black on white),
never white-on-light; header no longer lets scrolled transcript text show through.
