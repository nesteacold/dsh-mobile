# Roadmap DSH iOS/Android — Companion native kiểu Qoder (rev 2026-11-08)

- Rev này sửa hướng theo yêu cầu user: **BỎ P1 Capacitor/Tauri WebView shell** (không thích web nhúng). P1 mới = **Companion native thin-client kiểu Qoder**.
- P0 PWA/remote-host giữ lại **chỉ làm fallback tạm** khi chưa có app.
- Nguồn: `docs/arch-notes/dsh-mobile-arch.md` + bản roadmap cũ. Chi tiết P1 xem [dsh-companion-spec](dsh-companion-spec.md).
- Quy tắc vàng (không đổi): **Host giữ nguyên trên máy có Node; phone chỉ chạy Client.** Không nhét Host/Node/addon/PTY lên iOS/Android.

## 0. Quyết định đổi hướng (chốt)

- [x] Bỏ: bọc `apps/web/dist` trong Capacitor/Tauri, mọi bridge WebView.
- [x] P1 = app Companion native: render native, scope 4 màn (pairing, session list, chat+approve, push), Host remote giữ nguyên.
- [x] P0 = fallback tạm: Host + TLS proxy + auth + mở browser/PWA, **không đầu tư sâu** (xem §3).

## 1. Tóm tắt 3 pha (mới)

| Pha | Tên | Thời gian | Ý tưởng | Output |
|---|---|---|---|---|
| P0 | Remote-host fallback (tạm) | 3–5 ngày | Dựng Host + TLS/auth, dùng browser/PWA chờ app | URL `https://…` dùng được trên phone |
| P1 | Companion native MVP | 6–8 tuần | App thin-client render native, 4 màn, push khi cần quyết định | TestFlight + Play Internal |
| P2 | Mở rộng | Sau MVP, theo metric | Offline queue, attachments, share-sheet, plugin cards | Store production |

## 2. Stack P1: trade-off + default

| Phương án | Ưu | Nhược | Khi nào |
|---|---|---|---|
| A. SwiftUI + Compose (2 codebase) | UX/store tốt nhất, đúng guideline từng OS | Tốn nhất, 2 codebase drift | Chỉ khi MDM/compliance bắt buộc |
| B. **React Native + Expo (DEFAULT)** | 1 codebase **TypeScript** (team đã biết React 18 web), Expo EAS build/push/deep-link, FlashList cho chat dài | Cần bridge nhẹ, tối ưu list lớn | **Mặc định — đi B trừ khi có lý do cứng** |
| C. Flutter | 1 codebase, perf tốt, widget ổn định | Dart mới hoàn toàn, không tái dùng gì từ web | Chỉ nếu team đã thạo Dart |

- Vì sao default B: team DSH là React/TS (`apps/web` React 18) → học 1 lần dùng 2 nơi; WS/auth logic viết TS dùng chung iOS+Android; Expo xử lý sẵn signing/push/deep-link/OTA-fix-nhỏ.
- Cấm: nhúng Node/JIT/addon/PTY vào app (Store reject + sandbox giết) — mọi exec ở Host.

## 3. Backlog từng pha

### P0 — Fallback tạm (3–5 ngày, làm tối thiểu)
- [ ] P0-1 Dựng Host cố định: `pnpm install && pnpm run build && pnpm dsh web --host 0.0.0.0 --port 3080` (verify flags `dsh web --help`).
  - DoD: phone cùng WiFi mở được UI; restart không mất session (JSONL).
- [ ] P0-2 TLS + auth trước khi expose: Caddy/Nginx/Tailscale + OAuth/basic-auth proxy, allowlist device. **Không expose trần.**
  - DoD: thiếu token vào không được; log redact secret.
- [ ] P0-3 WS tối thiểu: reconnect/backoff + resume, banner mất mạng.
  - DoD: rớt 30s → foreground tự nối, không mất/dupe message.
- [ ] P0-4 DỪNG Ở ĐÂY — không làm PWA sâu, không Capacitor. Chuyển sức sang P1.

### P1 — Companion MVP (6–8 tuần, chi tiết ở `dsh-companion-spec.md`)
- [ ] P1-1 Pairing/auth: QR/pairing-code, per-device token (secure storage), biometric unlock, revoke 1 device.
  - DoD: mất máy → revoke xong máy khác không ảnh hưởng; token không plaintext.
- [ ] P1-2 Session list: tabs running/idle/archived, search, pull-refresh, badge needs-decision.
  - DoD: 200 session scroll mượt (FlashList), badge đúng <5s sau event WS.
- [ ] P1-3 Chat + approve: message list (text/code gập được/plan-diff read-only), composer respond, thẻ approval (Approve/Deny/Edit+note, kèm payload-hash chống duyệt nhầm bản cũ).
  - DoD: approve 1 tay <3 tap; edit gửi kèm note; conflict có banner.
- [ ] P1-4 Push: APNs/FCM đăng ký từ app → Host webhook → push khi approval-request/plan-review; tap mở đúng session.
  - DoD: máy lock vẫn nhận; tap → đúng màn <3s; foreground fetch full.
- [ ] P1-5 Host API/WS: pairing, session query, message stream (resume+replay), respond, approval-decision, push-token, deep-link resolve. WSS-only.
  - DoD: contract versioned, web cũ không vỡ.
- [ ] P1-6 Hardening + store + CI: cert pinning, ATS/assetlinks, EAS signing, TestFlight + Play Internal, smoke Maestro (login→pair→open→approve→reconnect).
  - DoD: QA cài không cần cable; build đỏ chặn merge.

### P2 — Mở rộng (chỉ khi metric MVP gọi)
- [ ] Offline queue (gửi khi mất mạng), attachments/share-sheet, biometric per-approval, MDM, plugin cards đầy đủ.
  - DoD: quyết định go/kill bằng văn bản từ số liệu (retention, crash-free, approval-latency).

## 4. Checklist chuẩn bị iOS/Android (cho P1)

- [ ] **Apple Developer** ($99/năm): bundle ID, TestFlight group, UDID test.
- [ ] **Play Console** ($25): application ID, track Internal → Closed → Production, assetlinks.
- [ ] **Signing (EAS)**: iOS cert/provisioning + Android keystore qua EAS secrets; backup key offline.
- [ ] **Push**: APNs .p8 + FCM project; Host webhook → push service.
- [ ] **Deep-link**: `dsh://s/:id` + universal/app links, fallback browser.
- [ ] **TLS/WSS**: `https/wss` everywhere, pinning, HSTS, cert auto-renew.
- [ ] **Auth**: per-device token + timeout + approval bắt buộc cho tool nguy hiểm.
- [ ] **CI/QA**: EAS build matrix, Maestro smoke 5 case, 1 iPhone + 1 Android thật.
- [ ] **Store policy**: quyền tối thiểu, privacy manifest + data-safety, không Node/JIT/dynamic-load.
- [ ] **Telemetry**: crash-free, WS reconnect rate, approval-latency, PII redacted, opt-out.

## 5. Spec-kit tiếp theo

> Lệnh init chi tiết xem `docs/spec-kit-notes/spec-kit.md` §4 — chưa chạy, chờ lead duyệt integration.

1. `specify init` → sinh `.specify/`.
2. Constitution:
   ```text
   /speckit-constitution Create principles for DSH Companion: host-stays-remote, native-render-no-webview, WSS-only, per-device-auth, approval-payload-hash, store-policy compliance.
   ```
3. Spec P1 (copy-paste, prompt đầy đủ ở `dsh-companion-spec.md` §6):
   ```text
   /speckit-specify Build DSH Companion native MVP (React Native + Expo, TypeScript): device pairing via QR code with per-device token, session list running-idle-archived, chat with approve-deny-edit approval cards including payload hash, APNs-FCM push on approval-requested with deep-link to session, WSS with resume token, remote Host unchanged. Slug dsh-companion.
   ```
   - Output: `specs/002-companion-app/spec.md` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement` + `/speckit-converge`.
