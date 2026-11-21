# Compact button

Private, client-only DSH plugin for spec 059. Supports `>=0.2.2-rc.5 <0.3.0-0`.
Registers `dsh-ext-compact-button` (order 5) in `conversation.composer.dock`.
The native context ring stays beside it and keeps its token breakdown behaviour.

The icon and percentage use the native projected-token formula, capped at 100%.
Missing or invalid pressure hides the button. Below 40% the colour is neutral;
40% is orange and 70% is red. DSH theme variables have hex fallbacks.
An idle session with an empty draft submits `/compact` through the existing
composer (`setDraft` followed by `submit`). A non-empty draft, including whitespace,
is preserved and clicking shows a translated inline notice. English and Vietnamese
strings live in `locale/`; the current DSH locale selects the language.
The normal tooltip is “Context NN%, click to compact”. No automatic compaction.

Read from installed DSH 0.2.2-rc.5 source: `useInput(selector)` exposes `draft`,
`phase` and `attachmentIds`; `useSessionStatus(selector)` exposes a Map keyed by
session ID with `running` and `pendingInteraction`. Only `running === false`, no
pending interaction, plain input and no attachments permit clicking. Unknown
state or missing composer actions disables the button to preserve user input.
The button does not wrap services, patch DOM, mutate DSH files, or open listeners.
Remote sessions use the same composer actions without a separate transport.

`npm run build` generates `lib/client.js` from the client source, pure logic and
locale JSON, with no dependencies. `npm test` checks the generated artifact and
exercises logic and slot/component behaviour using `node:test`.

Live verification is pending: this task explicitly prohibits profile installation.
After owner-directed installation, check a local and a Devices remote session:
at >=40% the button is orange, clicking an empty idle composer starts compaction
and the percentage drops; busy input is disabled and a draft survives clicking.
