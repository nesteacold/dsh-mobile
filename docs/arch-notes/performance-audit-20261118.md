# Performance remediation status — 2026-11-18

## Evidence scope
Source audit and targeted regression tests, not whole-codebase certification or proof of live speedup. No core modifications, commits, publishing or deliberate application restart performed by the integration lead. Preserve unrelated working-tree edits.

## Implemented and independently reviewed
- Devices client: sidebar-disjoint mutation filtering, allocation reduction, coalesced host refresh, unchanged snapshot suppression, removal of duplicate sync, hidden-page polling gate, request/body timeout handling and symmetric listener cleanup. Lead rerun: client-host-tabs 37 passed; client 102 passed. Reviewer PASS.
- Gateway: best-effort 10 MiB logger rotation, bounded UTF-8 file entries, refusal of non-regular rotation destinations, suppression of idle/subagentTiming projection diagnostics without changing broadcasts. Final coder run: 24 passed, 1 skipped (Windows symlink EPERM); lead earlier final source run 25 reported passed before skip-report correction. Agent-team lead rerun 4 passed. Reviewer PASS.
- Wiki (separate repository): asynchronous discovery/static asset reads, throttled registry timestamps, pending timer cleanup; removed erroneous new 5-minute root/project/wiki caches; coalesced background discovery for synchronous cold /wiki list. Lead final harness ALL PASS and MCP 114 passed, 0 failed. Reviewer PASS.
- Scoped git diff --check exit 0.

## Deployment status
Desktop profile node_modules entries for devices/mobile-gateway/dsh-wiki are symbolic links to workspace sources (measured). This does not prove the running Host or renderer has reloaded those modules. No promise of automatic HMR. No deployment/restart was forced.

## Measurements and corrections
- Early process snapshots showed approximately 3 GiB Host private memory and 2 GiB renderer private memory. Cumulative CPU seconds do NOT measure instantaneous CPU load. Process memory alone does not establish a leak or plugin attribution.
- Current application processes started 08:12, unlike the early baseline. A later snapshot: Host PID45308 private 2341.3 MiB; renderer PID55856 private451.4 MiB, handles372. Different start time/workload prevents causal before/after comparison.
- Earlier inventory: sessions 1052.85 MiB /2224 files; this does not imply all are resident in heap.
- Earlier Inspect tool manifest snapshot: 105 tools, 280889 UTF-8 JSON bytes; ComfyUI group approximately213.8 KiB. Token counts previously estimated from byte ratios were NOT tokenizer/request measurements. Actual model tool set may differ by timing/backend. Compact mode is a candidate recommendation only, not applied.
- Prior claim that Google Slides performs synchronous in-process slideshow writes was unsupported and withdrawn. Its bundle configures external workspace-mcp; it was not established active in the inspected profile.
- Extensive integration tests in package scripts do not imply those tests run on activation. That earlier inference was invalid.

## Known limits / intentionally deferred
- Logger rotation is not atomic across processes, legacy oversized log archive remains after first rotation, raw restart child stdio bypasses logger, and statSync adds metadata I/O. No strict total20MiB guarantee. No existing logs manually deleted.
- Wiki cold command is eventually consistent; first synchronous response may omit undiscovered siblings. In-flight filesystem operations can finish after unload.
- Devices polling cancellation on disposal does not abort an existing shared request. Snapshot comparison remains linear and default timeout depends on AbortSignal.timeout availability.
- No session-cache async conversion, FIFO cache rewrite, WebSocket backlog ceiling, full package gates, whole-source audit, heap attribution or live A/B benchmark is claimed complete.
- Existing root package.json is empty, while dsh-mobile has no root package manifest. Run plugin tests in plugin directories; do not invent a workspace root manifest or install test runners.

## Remaining verification
Verify exact served Devices module bytes, then refresh existing GUI and verify loaded version when safe. Capture comparable idle/streaming CPU deltas, memory/handle trends and request/observer work under matched workload. Host changes require confirmed reload before attributing log or registry behavior to new code.
Goal remains incomplete until deployment/behavioral evidence supports completion. Owner initially selected not to restart, then reported a restart. Follow-up process evidence still showed main PID46796, Host PID45308 and primary renderer PID55856 created at08:12 (before source changes08:52–09:03). Thus a full process restart was not established; hot reload remains possible but unverified. Do not forcibly terminate the application or remote connections.

## Post-reported-restart sample
A30.01-second sample: Host PID45308 CPU12.34% of one core, private2243.6MiB (delta−124.9MiB), handles539 (delta−10); primary renderer PID55856 CPU9.84%, private541.7MiB (delta+49.6MiB), handles382 (delta−3); GPU CPU1.56%, private217.9MiB (delta−131.4MiB). Workload not controlled; not a matched speedup measurement. Active log564737 bytes; legacy archive328340900 bytes. No evidence of sustained handle growth in this short sample; no leak ruled out.

## Final handoff sample
A 10.09-second process sample (not a matched before/after benchmark) measured Host PID45308 at 9.91% of one CPU core, private2356.9MiB, handles519; primary renderer PID55856 at0% of one core, private439.2MiB, handles372; GPU PID45584 at0.15% of one core, private262.2MiB, handles702. No causal performance improvement claimed.

Resume after owner reports a restart: rediscover PIDs and active GUI URL; confirm loaded module version through authenticated GUI without extracting credentials; measure comparable idle and streaming workloads, including CPU delta per elapsed second, private memory/handles trend, and correctness of remote sidebar/attachment/polling. Do not rerun completed jobs or infer a leak from one snapshot. Outstanding optional Spec042 work is explicitly separate from the reviewed changes above.

Served-byte probe: existing GUI root returned HTTP401 without authentication; no credentials used. Exact module URL and executed-version match remain unverified. Local Devices SHA256 at probe time: D4B03D652242DD54AA3C39FAA5621D5B1410FFA1FCF00E3D7DCD07E3B63B04E9.
