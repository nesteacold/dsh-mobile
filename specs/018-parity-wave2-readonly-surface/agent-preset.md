# 018 item — per-session agent preset (lead decision 2026-11-12)

Source: docs/arch-notes/agent-preset-survey.md.

v1 = VIEW ONLY. The session screen shows the session's agent preset name and whether it is locked
(locked once the first turn exists). No new scope: the value must reach the device through data it
already receives under `sessions:read`, as a plain string id (no YAML, no `broken` diagnostics, no
paths). Choosing or changing a preset from the phone widens the agent's tools (presets can load any
plugin) and is NOT built until the owner approves it; if approved it gets a never-default scope,
a fresh catalog check, and reviewer sign-off. `set-default` and `agentPresets/read` stay desktop-only.