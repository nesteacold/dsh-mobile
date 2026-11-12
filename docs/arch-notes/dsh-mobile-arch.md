# DSH Mobile Architecture Notes

- Date: 2026-11-08
- Target: DeepSeek Harness (`dsh`) phục vụ bản mobile
- Upstream version khảo sát: `0.2.2-rc.1`
- Workspace local: `C:\Users\me\Documents\DSH_Project` (now `dsh-ext/docs/arch-notes/dsh-mobile-arch.md`)

## 0. Nguồn (read-only, không clone nặng)

1. Root `package.json` — workspaces `apps/*`, `native/system`, scripts `package:desktop`:
   https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/package.json
2. `README.md` — cách chạy `npx dsh web`:
   https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md
3. Liệt kê `apps/` (cli, desktop-host, desktop, plugin-market-generator, web):
   https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/apps?ref=master
4. Liệt kê `native/` (chỉ `system/` + README):
   https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/native?ref=master
5. Kiểm chứng bổ sung trong phiên này (web_fetch):
   - `apps/desktop/package.json`: `{"name":"@deepseek-ai/dsh-desktop","description":"Electron desktop shell for a bundled dsh runtime..."}`, deps `electron ^44.7.0`, `electron-builder ^26.17.0`, `electron-updater`.
   - `apps/web/package.json`: `{"name":"@deepseek-ai/dsh-web-frontend","description":"Web application entry: vite build over the @deepseek-ai/dsh-client-web shell library; dist/ served by apps/cli's dsh web"}`, deps `react ^18.2.0`, `react-dom`, `vite ^6.4.3`, `@vitejs/plugin-react`, `ws 8.21.3`, `fflate`.
   - `apps/cli/package.json`: `{"name":"@deepseek-ai/dsh","bin":{"dsh":"lib/bin.js"}}`, deps `@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-host-frontend-static`, `@deepseek-ai/dsh-terminal`, `@deepseek-ai/dsh-tool-terminal`, `dsh-cua-bundle` (computer-use), `dsh-fs-sandbox`, `dsh-sandbox-local`, `ws 8.21.3`, `engines: node >=24.9.0`.
   - `native/system/package.json`: `{"name":"@deepseek-ai/node-addon-system-workspace"}`, devDep `@deepseek-ai/node-addon-system`, scripts `build:native: tsx ./scripts/build.ts`.

Kết luận release `v0.2.2-rc.1` đã biết: cải thiện phone/tablet = Web responsive, không phải app native. Điều này khớp với thực tế `apps/web` là Vite build static + `apps/cli dsh web` serve, không có `apps/ios` hay `apps/android`.

---

## 1. Frontend stack (dự đoán có kiểm chứng)

| Lớp | Bằng chứng | Nhận xét mobile |
|---|---|---|
| Build | Root devDep `vite 8.2.2`; `apps/web` devDep `vite ^6.4.3`; scripts `build:web: pnpm --filter @deepseek-ai/dsh-web-frontend run build`, `dev:web: tsx scripts/dev-web.ts --poll` | Chuẩn Vite SPA, dễ bọc WebView/PWA, không cần port build system. |
| UI | `apps/web` + `apps/desktop`: `react ^18.2.0`, `react-dom ^18.2.0`, `@vitejs/plugin-react`; UI packages `dsh-client-ui-*` (primitives, theme, slots, dockkit, deliverables, sidebar-browser, settings-general) | React 18 DOM, không phải React Native. Tái dùng 100% nếu chạy trong WebView/PWA; viết lại nếu chọn RN. |
| Client shell | `apps/web` description: "vite build over the `@deepseek-ai/dsh-client-web` shell library" | `dsh-client-web` là shell chuẩn cho mobile-web. Desktop tái dùng cùng client packages + thêm theme/shortcuts. |
| Test web | `vitest.web.config.ts`, `vitest.web-stress.config.ts`, `vitest.web.perf.config.ts`, Playwright trong `apps/web` devDeps | Đã có harness test web/perf/stress — dùng lại để gate responsive/mobile. |
| Thử nghiệm webworker | `apps/web` devDeps `@deepseek-ai/dsh-experimental-webworker-runtime`, `dsh-experimental-webworker-packer`, script `build:preview` + `dsh-pack-vfs-image --out dist/preview/vfs-image.tar.gz` | Hướng chạy không-Node trong browser (preview/VFS). Gợi ý cho mobile offline/PWA, nhưng còn `experimental`, chưa thay được Host Node. |

## 2. Host / Client Cordis

- Triết lý: "everything-is-a-plugin", powered by [Cordis](https://github.com/cordiverse/cordis) (theo README).
- Root scripts phân biệt rõ 2 mặt:
  - `build:lib:host`: `tsx scripts/compile-referenced-projects.ts host-libraries && tsc -p tsconfig.host.json`
  - `build:lib:client`: `tsc -b tsconfig.client.json && tsdown --config-loader native --env.DSH_BUILD_FACE client`
- CLI (`apps/cli`) là Host: gom `cordis`, `cordis-plugin-loader/include/timer`, `dsh-app-boot`, `dsh-web-app`, `dsh-host-webserver`, `dsh-host-frontend-static`, session/agent/LLM/MCP/sandbox/subprocess.
- Web (`apps/web`) là Client: gom `dsh-client-modules`, `dsh-client-store`, `dsh-client-web`, `dsh-cordis-client-runner`.
- Desktop (`apps/desktop`) kẹp giữa: deps `@deepseek-ai/dsh-api-gateway`, `@deepseek-ai/cordis`, `ws` — tức Electron shell + bundled dsh runtime, nói chuyện qua API/WS chứ không nhúng trực tiếp toàn bộ Host vào renderer.
- Hệ quả mobile: giữ nguyên ranh giới Host (Node, chạy remote) / Client (React, chạy trên phone). Đừng cố nhét Host lên iOS/Android.

## 3. `npx dsh web` (CLI serve Web)

Theo `README.md`:

```sh
npx @deepseek-ai/dsh web
# → Web UI tại http://127.0.0.1:3080 mặc định, local thì auto-open browser
```

Từ `apps/cli/package.json` + root scripts:

- `start:web: node --import tsx/esm apps/cli/src/bin.ts web`
- `dsh: node --import tsx/esm apps/cli/src/bin.ts`
- Host serve static `dist/` của `apps/web` qua `dsh-host-frontend-static` + `dsh-host-webserver`.
- Đây chính là mô hình "remote host" cho mobile: dựng Host trên PC/server/VPS, phone chỉ mở URL qua LAN/Tailscale/HTTPS reverse-proxy. Không cần build app mới cho P0.

## 4. Desktop packaging là gì? (Đã kiểm chứng: Electron)

- `apps/desktop/package.json`:
  - `name: @deepseek-ai/dsh-desktop`
  - `description: "Electron desktop shell for a bundled dsh runtime and external plugins"`
  - `main: lib/main.js`, build `tsc -b && tsdown`, package qua `tsx scripts/package-target.ts`
  - Deps: `electron ^44.7.0`, `electron-builder ^26.17.0`, `electron-updater ^6.8.9`, `koffi`, `sharp`, `@deepseek-ai/node-addon-system`
- Root scripts: `package:desktop`, `package:desktop:dir`, `package:desktop:mac:arm64`, `package:desktop:win:x64`, `upload:*`, v.v.
- `apps/desktop-host` tồn tại riêng (chưa đọc sâu, tên gợi ý Host chạy kèm Desktop, tách khỏi Electron renderer).
- Kết luận: Desktop = Electron + electron-builder, bundling dsh runtime + plugins. Không tái dùng trực tiếp cho iOS/Android (không có Capacitor/Tauri-mobile/Electron-mobile). Muốn shell mobile phải làm shell mới (xem §7).

## 5. Giao tiếp: WebSocket + compression, auth/session, plugin system

- **WebSocket**: `ws ^8.21.3` xuất hiện ở cả `apps/cli` (devDep), `apps/web` (devDep), `apps/desktop` (dep). `dsh-cordis-client-runner` + `dsh-remote-mock` gợi ý client runner qua remote channel. Mobile dùng WS/WSS là đường chính; phải lo reconnect, heartbeat, backoff khi chuyển mạng/lock screen.
- **Compression**: `fflate ^0.8.2` ở root devDeps + `apps/web` devDeps; `build:bench`/`test:bench`/`test:web:perf` cho thấy bench snapshot/VFS. Dự đoán payload WS/session-projection dùng fflate (deflate/gzip-compatible) để giảm data mobile. Cần verify thêm `packages/*/src` nếu đi sâu, nhưng ở mức arch-note coi đây là giả định có cơ sở.
- **Auth/session**: `apps/cli` có `dsh-credentials-local`, `dsh-session`, `dsh-session-persistence-jsonl`, `dsh-session-projection`, `dsh-session-checkpoint-policy`, `dsh-settings`, `dsh-deepseek-llm-api-extensions`, `dsh-user-approval`, `dsh-agent-team`. Web UI mặc định bind `127.0.0.1:3080` (local trust). Mở ra LAN/internet cho phone = phải thêm auth (token/OAuth), TLS, session timeout, per-device approval — hiện chưa thấy trong 5 nguồn, đánh dấu gap P0.
- **Plugin system**: everything-is-a-plugin + loader YAML dialect (`insert/override by id/group/disabled/isolate/!!js` theo skill `cordis-composition-reference`), catalog generators (`gen-cordis-catalog`, `gen-client-catalog`, `gen-plugin-packages`, `gen-official-bundle-catalog`, `dev:bundle-registry`). Mobile client tự động hưởng plugin UI mới nếu đi đường WebView/PWA + remote host; RN/native phải port từng slot.

## 6. Native rào cản mang lên mobile

| Rào cản | Bằng chứng | Vì sao kẹt trên iOS/Android |
|---|---|---|
| Node >= 24.9 | Root `engines: node >=24.9.0`; `apps/cli` `engines: node >=24.9.0`; `pnpm 11.28.5`, `tsx`, `tsdown`, `@yao-pkg/pkg 6.21.0` | iOS/Android không có Node chính chủ. Không thể `pnpm install && pnpm dsh web` trên phone. Phải để Host ở remote. |
| Native addon `node-addon-system` | Workspaces `native/system`, `native/system/packages/*`; `build:native-system: tsx native/system/scripts/build.ts --host-addon-only`; Desktop devDep `@deepseek-ai/node-addon-system`; `koffi 3.1.1` | N-API/prebuild per-OS/arch. Không load được trên ARM-iOS/Android không-jailbreak; Apple/Google Store chặn JIT/dynamic load tùy trường hợp. |
| PTY / terminal | Root devDeps `dsh-tool-terminal`, `dsh-tool-executor-native`, `dsh-tool-executor-ptc`, `dsh-tool-bash`, CLI deps `dsh-terminal`, `dsh-terminal-bash`, `dsh-tool-bash-persistent`, `dsh-tmux-context` | iOS không cho forkpty/process spawn tự do; Android cũng bị scoped storage + background-exec limits. Terminal full chỉ sống ở Host remote. |
| Computer-use / browser-use / CUA | Root devDeps `dsh-computer-use`, `dsh-browser-use`, `dsh-cua`, `dsh-experimental-computer-use-cua-driver-native`, CLI `dsh-cua-bundle` | Cần OS-level input capture + Accessibility API + native driver. Mobile sandbox cấm tổng quát; chỉ làm được via remote desktop stream, không điều khiển trực tiếp phone OS. |
| Filesystem / sandbox | CLI `dsh-fs-local`, `dsh-fs-sandbox`, `dsh-sandbox-local`, `dsh-sandbox-policy`, `dsh-pwsh-sandbox`, `dsh-subprocess-local`, `dsh-bash-local` | iOS/Android sandbox: scoped storage, không truy cập arbitrary path, background process bị kill. Mọi fs/exec phải ở Host, phone chỉ là viewer + approval UI. |
| Packaging | Desktop = Electron/electron-builder (x64/arm64 mac/win) | Không có pipeline iOS/Android. Store review (ATS, NSAppTransportSecurity, background modes, push) là việc mới hoàn toàn. |

Quy tắc vàng: **Host giữ nguyên trên máy có Node; phone chỉ chạy Client.**

---

## 7. Ma trận tái dùng cho iOS/Android

| Phương án | Cách làm | Tái dùng UI/logic | Ưu | Nhược | Phù hợp |
|---|---|---|---|---|---|
| **A. WebView/PWA trỏ về remote host** | Phone mở `https://host:3080` (hoặc app shell WebView mỏng); PWA manifest + service worker cache shell; WSS về Host | **90%+** (toàn bộ `apps/web` + plugin UI) | Nhanh nhất, hưởng responsive `v0.2.2-rc.1`, plugin mới tự có, không port UI | Cần Host online, xử lý TLS/auth/reconnect, UX kém "native" (push, share-sheet, files) | **P0 — làm trước** |
| **B. Capacitor / Tauri-mobile shell** | Bọc `apps/web/dist` trong Capacitor/CapacitorJS hoặc Tauri mobile + WSS config tới Host; thêm plugin bridge cho camera/share/push/biometric | **~80–90%** web + bridge native mỏng | Có icon App Store/Play, push/biometric/share, vẫn 1 codebase web | Thêm toolchain Rust/Xcode/Gradle, phải duy trì 2 store builds, plugin native riêng | **P1** |
| **C. React Native (viết lại UI)** | Giữ Host + WS protocol, viết lại screens bằng RN + `dsh-sdk-client`; tái dùng design tokens (`dsh-client-ui-theme`) | **~30–50%** (protocol + design, mất DOM components) | UX native thật, offline-first dễ hơn, performance list/chat tốt | Rewrite lớn (`dsh-client-ui-*`: dockkit/slots/primitives không chạy trên RN), dual-track web/RN drift | **P2, chỉ khi P0/P1 chứng minh cần native UX** |
| **D. Native Swift/Kotlin** | Viết lại client WS + UI bằng SwiftUI/Jetpack Compose | **~10–20%** (chỉ protocol/docs) | Tối ưu platform, Store-friendly | Tốn nhất, 2 codebase, mọi plugin UI phải port tay | **Tránh trừ khi yêu cầu Store/compliance bắt buộc** |

Lưu ý: `dsh-experimental-webworker-runtime/packer + VFS image` có thể giảm phụ thuộc Host cho preview/offline, nhưng còn experimental — không đặt cược P0 vào đó.

## 8. Khuyến nghị pha P0 / P1 / P2

### P0 — Remote Host + Mobile Web (1–2 tuần, không đổi kiến trúc)
1. Dựng Host cố định (PC/server/VPS): `pnpm install && pnpm run build && pnpm dsh web --host 0.0.0.0 --port 3080` (verify flags qua `scripts/gen-cli-help.ts` / `dsh web --help`).
2. Reverse-proxy TLS (Caddy/Nginx/Tailscale Serve) + auth tối thiểu (basic-auth/OAuth proxy, allowlist device) vì mặc định chỉ local trust.
3. QA responsive `v0.2.2-rc.1` trên phone/tablet thật (Safari iOS + Chrome Android): nav, dock, sidebar-browser, terminal view (read-only), approval dialogs, bàn phím ảo che input.
4. Thêm PWA manifest/icons (có sẵn script `apps/web/scripts/render-app-icons.ts` + `sharp`) + `<meta viewport>`, theme-color, apple-touch-icon; đo Lighthouse mobile + `test:web:perf`.
5. Vận hành: reconnect/backoff WS, session persistence JSONL backup, log redaction trên mạng ngoài.

### P1 — Shell app mỏng (Capacitor/Tauri-mobile) + bridge cần thiết
1. Chọn 1: Capacitor (nhanh, web-first) hoặc Tauri-mobile (nhẹ, Rust bridge) — chỉ bọc `apps/web/dist`, không fork UI.
2. Bridge tối thiểu: secure storage token, biometric unlock, share-sheet (gửi link/file vào session), push (qua Host `dsh-schedule`/webhook), file picker scoped.
3. Hardening: certificate pinning, WSS-only, deep-link `dsh://host/...`, background WS policy (iOS suspend — chuyển sang push + fetch on foreground).
4. Pipeline store: signing, ATS/NSC exceptions tối thiểu, Play assetlinks.

### P2 — Cân nhắc RN/native chỉ khi có số liệu
- Trigger: PWA retention/UX không đạt, cần offline-first sâu, hoặc yêu cầu MDM/Store đặc thù.
- Nếu đi: đóng băng WS protocol + `dsh-sdk-client` contract trước, port theo slot (`slots/dockkit` → RN nav), giữ song song 1 bản web làm source-of-truth.

## 9. Rủi ro chính

1. **Mở Host ra internet mà không có auth chuẩn** → RCE/fs leak (Host có bash/pwsh/subprocess/sandbox). Mitigation: không expose trực tiếp, proxy + mTLS/OAuth, per-device token + user-approval cho tool nguy hiểm.
2. **WS trên mạng di động** (NAT, sleep, chuyển WiFi/5G) → mất session realtime. Mitigation: resume token + `session-projection-cache`, replay missed events, UI optimistic + conflict banner.
3. **Terminal/PTY/computer-use kỳ vọng chạy local** → thất vọng UX. Mitigation: gắn badge "remote execution", disable/collapse các action không hỗ trợ trên mobile, đưa approval lên trước.
4. **Apple/Google policy** (background exec, JIT, dynamic plugin load) → P1/P2 bị reject nếu cố nhúng Node/addon. Mitigation: giữ native shell thuần viewer + bridge, mọi exec ở Host.
5. **Drift nếu chọn RN/native** → chi phí x2. Mitigation: mặc định P0/P1, RN chỉ khi metric bắt buộc.

## 10. Bước tiếp theo đề xuất cho team

- [ ] Xác nhận flags `dsh web --host/--port/--auth` từ `apps/cli/src` + `docs/user/guide/index.md`.
- [ ] Wire PWA manifest + icons, chạy `pnpm run build:web && pnpm run test:web:perf:built` làm baseline mobile.
- [ ] Spike 1 ngày: Host trên laptop + phone cùng WiFi, đo WS reconnect khi lock/unlock.
- [ ] Thiết kế auth proxy tối thiểu trước khi expose khỏi `127.0.0.1`.

---
*Ghi chú: phân tích dựa trên 5 nguồn read-only nêu ở §0 + kiểm chứng package.json desktop/web/cli/native trong phiên; các chi tiết WS compression/auth nội bộ là suy luận có cơ sở, cần đọc thêm `packages/*/src` và `docs/architecture.md` để khóa lại trước khi code P1.*
