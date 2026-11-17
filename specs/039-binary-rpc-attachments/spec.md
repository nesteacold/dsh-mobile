# 039 — Binary RPC attachments across the remote bridge

Package: `plugins/mobile-gateway` (Host bridge) and `plugins/devices` (desktop client router). Owner-reported bug 2026-11-18: on a remote machine the workspace file list works, but previewing a Host image fails with `workspaceFiles/readBytes failed: [{ "code": "custom", "path": ["data"], "message": "invalid input" }]`.

## Root cause

DSH's gateway does not send `Uint8Array` inside JSON. `encodeRpcResult` / `writeBytes` replace it with a `null` placeholder and add `attachments: [{ path, bytes }]`; the connection layer sends those bytes as multipart and restores them into the placeholder (installed DSH source: `dsh-api-gateway/lib/index.js:1377-1401`, `dsh-client-connection/lib/index.js:938-969`, `dsh-client-connection/lib/client.node.js:348-392`). `workspaceFiles/readBytes` requires `data: z.instanceof(Uint8Array)` (`dsh-api-workspace-files/lib/typert.remote-client.js:69-76`).

The Host's `remote-bridge.mjs` calls `gateway.dispatchRpc`, then `describeResultValue(result.value)` without applying `result.attachments`, so `value.data` remains `null`. The controller's `host-router.mjs` likewise forwards a byte-bearing value without returning DSH's attachment envelope. The client therefore validates `data: null` and reports `invalid input`.

## Behaviour

1. On the Host, after `dispatchRpc` succeeds and before `describeResultValue`, apply every gateway attachment to its `null` placeholder. Validate each path like DSH's `parseBinaryResponse`: object segments must be own string keys; array segments must be safe integer indexes inside bounds; the target must be exactly `null`; use `Object.defineProperty` with the original descriptor flags; reject unsafe or malformed paths with a stable refusal and leak no bytes. Support root bytes (`path: []`) and nested `data` (`path: ['data']`).
2. On the controller, after a remote `connection.call` and `#ingress`, if a result carries a `Uint8Array` (including `Buffer`) at the root or at `value.data`, return DSH's shape: `{ ok: true, value: <value with data null>, attachments: [{ path: ['data'], bytes }] }`, or `{ ok: true, value: null, attachments: [{ path: [], bytes }] }` for root bytes. Preserve other fields (`offset`, `eof`, `absolutePath`, `version`, `bytes`).
3. Local calls, untagged sessions and all non-binary results keep their existing path unchanged. No new DSH method is wrapped; A1.1 remains limited to `dispatchRpc` / `openWireStream`.
4. The remote bridge's existing lazy binary chunking and credit-controlled stream path carry the restored bytes; no image is materialized into a single oversized one-shot frame.

## Tests

- Host bridge: fake `dispatchRpc` returns `{ ok:true, value:{ offset:0, eof:true, absolutePath:'...', version:'v', data:null }, attachments:[{ path:['data'], bytes:Uint8Array[...] }] }`; assert the upgraded remote result stream emits `$binary` chunks with byte-exact payload. Also cover root bytes, malformed paths/placeholders and no attachment.
- Devices router: fake remote returns a tagged `workspaceFiles/readBytes` result with `data: Buffer`; assert the wrapper emits `data:null` plus `attachments[0].path === ['data']` and byte-exact `bytes`. Assert a local call and a non-binary remote result are unchanged.

Manual acceptance: from the remote machine, open a Host image in Document Preview; it renders instead of showing `path:['data'] invalid input`.
