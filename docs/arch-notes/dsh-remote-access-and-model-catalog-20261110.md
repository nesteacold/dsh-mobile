# DSH remote access, model catalog and session addressing — measured on rc.1

Scope: facts about the **pinned** upstream `dsh-v0.2.2-rc.1` that the mobile companion depends on and
that are not documented in the public API surface. Every claim is labelled:

- **(a) measured** — observed by running code or by extracting and executing the shipped artifact;
- **(b) read from source** — quoted from the artifact, with file and line;
- **(c) inferred** — reasoning that follows from (a)/(b) but was not itself observed.

Artifact under study: `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`.
Files below are paths **inside** the asar; line numbers refer to the extracted file.

Why this note exists: three defects in the mobile product (an empty workspace list on a Host with nine
workspaces, a model picker that could not name a model, and a history button that could never load
anything) were each caused by an assumption about these internals that turned out to be false. Each
assumption is recorded here next to the measurement that replaced it.

---

## 1. How a device's authority is actually evaluated

`@deepseek-ai/dsh-api-remote-access/lib/index.js`

- `allows(resource)` builds the action string as `` `${namespace}/${method}` `` of the invocation and
  re-reads the bindings on **every** call (lines 252-262). There is no per-connection cache — a revoked
  scope therefore fails closed on the next request. **(b)**
- `evaluate(entry, bindings, action, resource, args)` allows only when
  `sameResource(binding.resource, resource) && binding.role.actions.includes(action)` (lines 335-361).
  There is no `condition` hook and no argument inspection at this layer. **(b)**
- `sameResource(left, right)` is `left.kind === right.kind && left.id === right.id` (lines 425-427) —
  **exact match, no wildcard**. An id of `'*'` authorizes nothing. **(a)** measured by evaluating a
  binding whose id is `'*'` against a real workspace id: `false`.

**Consequence for a client of this layer (c).** A resource-level action granted on `{kind:'global'}`
authorizes the **call**, but says nothing about the **rows** inside the answer. Anything that filters a
response per item needs a binding per item. This is the defect that produced "This computer has no
workspaces" on a Host with nine: the call was allowed, so it succeeded and returned `items: []` with no
error anywhere.

## 2. `workspace/follow` filters twice, with the same action

`@deepseek-ai/dsh-api-workspace-controller/lib/index.js`, `follow()` (lines 963-1011): **(b)**

- `items` are kept only where `allows({kind:'workspace', id: item.workspaceId})` (lines 965-977);
- `sessionIds` **inside each workspace** are kept only where `allows({kind:'session', id})` (line 969);
- `archivedSessionIds` and `pinnedSessionIds` are filtered the same way (lines 983-986);
- the action used for **all** of these checks is `workspace/follow`.

**Measured outcome (a)** on a policy that binds one `{kind:'workspace', id}` per known workspace with
actions `['workspace/follow']`:

| device | workspace items | nested `sessionIds` |
|---|---|---|
| holds `sessions:author` | 4 / 4 ids allowed | **always empty** |
| does not hold it | 0 / 4, `items: []` | empty |

The nested `sessionIds` stay empty because our per-session bindings carry session actions but not
`workspace/follow`. Nothing in the companion app reads them — and the gateway deliberately omits them
for a device without `workspace:manage` — so this is a **known, accepted limitation**, not a defect.
Do not "fix" it by adding `workspace/follow` to session roles without deciding that the extra authority
is intended: it would let a device enumerate which sessions belong to which workspace.

## 3. The model catalog's real shape

`@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js` (lines 29-60) and `typert.host.js`
(lines 3352-3390): **(b)**

```
ModelCatalog      = { default: ModelSelection, routableProviders: string[], groups: ModelProviderGroup[], failures: [...] }
ModelProviderGroup= { id            /* the PROVIDER id */, name, models: ModelCatalogModel[] }
ModelCatalogModel = { id, name, description?, reasoning?: { efforts: [{id,name,description?}], defaultEffort? }, badge? }
ModelSelection    = { provider, model, reasoningEffort? }
```

There is **no** `label`, **no** `displayName`, and **no** `group.provider` — the provider id lives in
`group.id`, and the human label lives in the model's `name`. The handler is
`modelCatalog() { return buildModelCatalog(this.ctx) }` (`types/index.js:424`). There is no Remote
`llm/models`; the catalog is reached through `session/modelCatalog` in both forms. **(b)**

**What the gateway exposes (b)** — `plugins/mobile-gateway/lib/dsh-host-adapter.mjs`:

- per-session form (`:364-376`): `{ current: <modelSelection.next ?? catalog.default>, routable, groups, failures }`
- global form (`:472-474`): `{ groups, failures }` — **drops `current` and `default` entirely**.

**Consequence (c).** A client that only ever asks for the global catalog can never know the current
model. The companion always passes a `sessionId`, so it is unaffected today; any future surface that
wants the current model without opening a session would need the adapter changed, not the client.

**The parser bug this exposed (a).** Our app read a flat `items`/`models` array and inherited a
provider from `group.provider`, so on a real Host the catalog parsed to `[]` and every row's provider
was `undefined` — while `session/selectModel` compares `candidate.id === selection.provider`
(`plugins/mobile-gateway/lib/index.mjs:1564`), so choosing a model would have failed too.

## 4. Session addressing: a sub-agent is not a session

`@deepseek-ai/dsh-api-session-controller/lib/index.js`, `validateAddress()` (lines 1154-1172): **(b)**

```js
if (address.kind === "session") {
  if (header.origin === "subagent")
    throw new RemoteError("session/agent-busy",
      "subagent Sessions require their durable parent address", …);   // line 1156
  return;
}
if (header.origin !== "subagent" || header.parentSession !== address.parentSessionId)
  throw new RemoteError("subagent/unauthorized", …);
if (address.mode !== "unknown" && identity.mode !== address.mode) throw …;  // line 1171
```

So a sub-agent must be addressed as
`{kind:'subagent', parentSessionId, childSessionId, mode:'unknown'}`; `mode:'unknown'` deliberately
skips the identity-mode comparison. **(a)** measured: `models` with a sub-agent id answered
`{"kind":"error","code":"session/agent-busy","message":"subagent Sessions require their durable parent address"}`
while the same call on a root id returned `current` plus `groups`.

`session/selectModel`'s request schema is `{sessionId, provider, model, reasoningEffort?}` with **no
address parameter** (`typert.host.js:1519`), and DSH resolves a child outright — a sub-agent therefore
**cannot** select a model. **(b)**

**Scale (a).** On the owner's Host, `session/list` returned 861 rows of which **827 were sub-agents**
(`origin:'subagent'`, with `parentSessionId`). Any per-session call a phone makes must assume the
session it received may be a child.

## 5. What follows for the companion (c)

1. Emit **one `{kind:'workspace', id}` binding per workspace id**, action `workspace/follow` only, when
   (and only when) the device holds the authoring scope. A `global` action alone yields a silent empty
   list.
2. Read the provider from `group.id` and the label from the model's `name`; never expect `label`,
   `displayName` or `group.provider`.
3. Resolve the durable parent for a sub-agent id instead of hard-coding a root address, using the
   `session/list` rows the peer may already list; a wrong parent fails closed (`subagent/unauthorized`),
   so the resolution is not itself a grant.
4. Treat `select-model` on a sub-agent as impossible and say so with a stable code, rather than
   surfacing a busy-looking error.
5. Never treat a "there is more" flag as permission to render a control: our history button was driven
   by `hasMore`, which the gateway can legitimately report as `true` while `nextBeforeSeq` is `null`
   (it only emits the cursor when it knows the oldest sequence, `plugins/mobile-gateway/lib/index.mjs:1412`).
   The control must be driven by the cursor.

## 6. Method note

The extractions and evaluations behind this note were done by reading the asar's offset table and copying
the relevant modules into throwaway scripts under `C:\Android\tmp\` (never into this repo, never written
back to the installation). The DSH code was transcribed verbatim with citations rather than imported,
because those modules require a live Cordis context and import packages that do not resolve outside the
asar. Nothing in the DSH installation was modified.
