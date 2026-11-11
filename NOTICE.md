# Notices and credits

This project is MIT-licensed (see [LICENSE](LICENSE)). It stands on work other people
published first, and that is worth stating plainly rather than burying.

## Forked code

**`plugins/mobile-gateway/`** is a fork of
[Clarklevis1995/dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway),
taken at upstream v0.12.0. The gateway's TLS listener, device registry, pairing flow and
device protocol come from there; this repository adds the companion-facing policy work,
the per-device projections, and the session-authoring surface.

MIT License text for the upstream work is reproduced below, as its licence requires.

```text
MIT License

Copyright (c) 2026 Clarklevis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Visual language and interaction reference

The companion's screens follow the layout, spacing rhythm, colour scheme and interaction
patterns of [Clarklevis1995/dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile)
(MIT), which is a native iOS/Android client for the same Host.

That reference is **not copied into this repository**: its Kotlin and Swift are not
present here, and none of its source was transliterated. What follows it is the design —
what the screen looks like and how it behaves — reimplemented in React Native with this
project's own state layer, contract client and native socket module.

## Host

This is an extension for [DeepSeek Harness](https://github.com/deepseek-ai). It does not
patch or fork the Host: it runs beside it as a Cordis plugin, declares `engines.dsh`, and
refuses to load on a Host version it was not built for.

## Assets

`plugins/mobile-gateway/docs/assets/` and `specs/*/reference/` contain images carried
over from the upstream plugin or captured as design references. They are documentation
material, not runtime assets, and nothing in the app or the gateway loads them.
