# PRODUCT.md — DSH Companion & Ecosystem Landing Page

## Product Identity
- **Ecosystem**: DSH Extensions (`dsh-mobile`, `dsh-wiki`, `dsh-vscode`) built for **DeepSeek Harness (DSH)** without forking or patching DSH core.
- **Primary Audience**: Developers, engineers, and technical leads running DeepSeek Harness on their workstation or private server who want to steer sessions, inspect diffs/approvals, search local codebases, and work from mobile, browser, desktop remote, or VS Code — **without trusting a third-party cloud relay**.
- **Languages**: Vietnamese (primary) and English toggle (`vi` / `en`), reflecting the bilingual user base of `dsh-mobile` and `dsh-wiki`.

## Three Core Software Products (1-to-1 with Our Repositories)

> **Owner correction (2026-11-18):** `dsh-mobile` is ONE cross-platform remote-control product running across **Android, iOS, Web (PWA), and DSH Desktop** — do NOT present Web/PWA as a standalone product whose headline feature is "Passkey screen lock". Present what the user actually *does* with each software product; keep authentication/transport details brief and secondary.

1. **`dsh-mobile` — Điều khiển DeepSeek Harness từ xa đa nền tảng (Android · iOS · Web · Desktop)**
   - **GitHub**: `https://github.com/nesteacold/dsh-mobile`
   - **Core purpose**: Máy tính hoặc server chạy DeepSeek Harness thực thi công việc; bạn theo dõi phiên, chat, gửi file và duyệt lệnh từ điện thoại, trình duyệt web hoặc một máy tính khác.
   - **Concrete features**:
     - **Đa nền tảng (DSH Orbit trên Android, iOS, Web & Desktop Remote trên máy tính):** Mở trên điện thoại, cài/chạy ngay trên trình duyệt web (qua mạng riêng Tailscale mà không cần qua chợ ứng dụng), hoặc gộp thẳng nhiều máy trạm/server vào thanh bên của DSH Desktop (*This Computer* / *Remote Workspace*).
     - **Theo dõi phiên & hội thoại trực tiếp:** Xem danh sách workspace và phiên đang chạy (kể cả sub-agent), đọc đầy đủ Markdown, khối code và kết quả chạy công cụ theo thời gian thực.
     - **Gửi lệnh, đính kèm file & chống mất mạng:** Gửi chỉ dẫn mới, truyền file trực tiếp sang máy từ xa (trên Desktop), giữ danh sách phiên + đọc lịch sử lưu đệm và tự xếp hàng gửi lại tin nhắn khi có mạng lại.
     - **Duyệt công cụ 1 chạm & quản lý thiết bị tập trung:** Nhận thông báo khi agent chờ duyệt lệnh/hỏi thêm thông tin để bấm *Allow once* / *Reject* ngay từ xa; tạo phiên mới, đổi model, ghép đôi bằng QR/mã 5 phút và thu hồi quyền từng thiết bị trong `Settings → Devices` (bảo vệ bằng ghim chứng chỉ TLS, Face ID/vân tay trên mobile và Passkey trên trình duyệt).

2. **`dsh-wiki` — Tạo trang tài liệu kiến trúc cho Repo & bộ tra cứu MCP cho AI (`v0.3.3`)**
   - **GitHub**: `https://github.com/nesteacold/dsh-wiki`
   - **Core purpose**: Tự động đọc codebase ngay trên máy và dựng thành website tài liệu kiến trúc kiểu DeepWiki lưu trong `.dsh-wiki/` để cả người và AI tra cứu — không tải code lên mạng.
   - **Concrete features**:
     - **Tạo trọn bộ wiki bằng `/wiki generate`:** Tự lập cây mục lục, viết bài giải thích từng module, vẽ sơ đồ luồng dữ liệu Mermaid và đóng gói thành trang HTML đọc offline (có tìm kiếm toàn văn, giao diện sáng/tối).
     - **Trích dẫn `file:dòng` được kiểm tra tự động:** Mọi mô tả đều gắn đường dẫn file và số dòng thật trong repo; bước kiểm tra tự báo lỗi nếu trích dẫn sai file hoặc lệch dòng.
     - **Thẻ kiến thức (Knowledge Cards) & cập nhật theo `git diff`:** Lọc nhanh từng API/module dạng thẻ tóm tắt; khi sửa code chỉ cần cập nhật lại đúng các trang bị ảnh hưởng.
     - **5 công cụ tra cứu cho DSH & MCP cho Claude Code / VS Code:** Cung cấp `wiki_search`, `wiki_page`, `wiki_cards`, `wiki_impact`, `wiki_status` để AI nắm cấu trúc dự án trước khi sửa code.

3. **`dsh-vscode` — Tiện ích tích hợp DeepSeek Harness trong VS Code (`v0.1.0 · Đang phát triển`)**
   - **Repository**: Đang phát triển nội bộ (sắp công bố trên GitHub).
   - **Core purpose**: Đưa DeepSeek Harness vào thẳng cửa sổ VS Code giống trải nghiệm của Claude Code — vừa code vừa giao việc cho agent và duyệt từng dòng thay đổi ngay trong trình soạn thảo.
   - **Concrete features**:
     - **Khung chat mở thành tab Editor hoặc thanh bên phải:** Đồng bộ màu sắc và biểu tượng gốc của VS Code, gom gọn bước suy nghĩ/gọi tool thành 1 dòng thoáng mắt.
     - **Tự gửi ngữ cảnh đang làm việc cho Agent:** Đính kèm file đang mở, đoạn code đang bôi đen và danh sách lỗi Diagnostics trong workspace qua máy chủ IDE MCP nội bộ.
     - **Xem trước Diff gốc của VS Code trước khi sửa file:** Mọi thay đổi đều mở bảng so sánh trực quan để bạn bấm duyệt hoặc từ chối rõ ràng.
     - **Hoàn tác gọn cả lượt chạy (Revert Turn) & giao thức ACP v1:** Chụp snapshot đầu mỗi lượt để khôi phục sạch về trạng thái cũ chỉ với 1 cú nhấp; kết nối bền vững qua chuẩn ACP v1 (và đang bổ sung kết nối máy chủ từ xa qua `dsh-mobile`).

## Canonical GitHub Links
- **GitHub Profile**: `https://github.com/nesteacold`
- **`dsh-mobile` repository** (DSH Orbit Mobile App, DSH Orbit Web PWA, DSH Desktop Remote `plugins/devices`, Host Gateway `plugins/mobile-gateway`, wire contract `packages/mobile-protocol`): `https://github.com/nesteacold/dsh-mobile`
  - Sub-paths:
    - Mobile & Web PWA: `https://github.com/nesteacold/dsh-mobile/tree/main/apps/mobile-companion`
    - Desktop Remote: `https://github.com/nesteacold/dsh-mobile/tree/main/plugins/devices`
    - Mobile Gateway: `https://github.com/nesteacold/dsh-mobile/tree/main/plugins/mobile-gateway`
- **`dsh-wiki` repository** (Repo Wiki `@dsh-ext/dsh-wiki` v0.3.3): `https://github.com/nesteacold/dsh-wiki`
- **`dsh-vscode` repository**: Local development checkout (`v0.1.0 · In Development`) — no public GitHub repository yet; state this plainly rather than linking to a 404 URL.

## Copywriting Discipline (Zero "AI Slop" / Zero Literal Translation)
- Write for real developers asking *"Cái phần mềm này dùng trong tình huống nào và làm được những tính năng cụ thể gì?"* — lead every product with its concrete everyday workflow and 4 clear user-facing capabilities, keeping protocol internals (`argsHash`, `RFC 8291`, `certSha256`, `WebCrypto IndexedDB`) concise or in the Security/Architecture section.
- **Forbidden machine-translated Vietnamese phrases**: never translate software "client" as `"khách hàng"`, "opt-in" as `"chọn tham gia"`, "surface" as `"bề mặt"`, "atomic cards" as `"Knowledge Cards nguyên tử"`, or "working title" as `"Tên dự án"`. Write natural, idiomatic Vietnamese matching `dsh-mobile/README.vi.md` and `dsh-wiki/README.vi.md`.
- Every setup command/config shown in `#setup` must be a real, documented command or UI path from the repos — never invented pseudo-code like `hosts.add(...)` or non-existent scopes like `approvals:write` (the real scope is `approval:respond`).

## Trust & Security Invariants (Non-Negotiable Copy Rules)
- Host executes; clients control.
- Zero public relay servers; zero telemetry; loopback by default.
- Never claim unshipped features (no Cloudflare tunnel, no WebRTC P2P, no native APNs/FCM push).
- Never use third-party "Whaleness" brand assets, whale marks, or third-party app screenshots.
