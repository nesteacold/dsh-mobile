# DSH Mobile

Ứng dụng đồng hành native cho một Host DeepSeek Harness. Đây là bộ điều khiển từ xa,
không phải bản sao thứ hai của app desktop: Host vẫn là nơi thực thi, điện thoại nhìn
thấy Host đang làm gì và nói cho Host biết cần làm gì tiếp.

Không có WebView, không nhúng runtime JavaScript nào. App là React Native + Expo, và
phần native duy nhất là cầu WebSocket ghim chứng chỉ — vì hợp đồng yêu cầu TLS pinning
và bắt tay chứng minh sở hữu khoá mà WebSocket client mặc định không diễn đạt được.

## Bạn thực sự nhận được gì

- **Danh sách phiên là danh sách của chính Host.** Bộ chọn workspace, phiên gần đây,
  nhãn trạng thái, thời gian tương đối, và — sau một lần mở — cả các phiên tác tử con,
  thứ trên một Host bận rộn có thể nhiều gấp hai mươi lần số phiên thật.
- **Tạo phiên từ điện thoại** khi thiết bị được cấp `sessions:author`: tạo phiên trong
  workspace đã chọn rồi mở ra. Không có quyền thì nút bị tắt *và nói rõ lý do*; bị thu
  hồi giữa chừng thì ngừng hoạt động ngay ở request kế tiếp, không phải sau lần nối lại.
- **Hội thoại có thể thao tác.** Tin nhắn markdown, dòng công cụ, thẻ phê duyệt, hàng
  model hiện đúng model của Host, và ô soạn tin báo trạng thái gửi một cách trung thực:
  đã gửi, bị từ chối kèm lý do, hoặc chưa được xác nhận sau thời gian chờ — không bao
  giờ có bong bóng giả vờ "đang gửi" mãi mãi.
- **Ghép đôi mà người thật làm được.** Host hiện mã thách thức, điện thoại trả lời bằng
  bằng chứng gắn với chứng chỉ TLS, chủ máy duyệt trên desktop, và chỉ sau đó điện thoại
  mới nhận token. Mã đóng kết nối tách bạch (403 / 408 / 410 / 401) để app phân biệt
  thiết bị bị thu hồi với máy không tới được.

## Trong repo có gì

| Đường dẫn | Nội dung |
|---|---|
| `apps/mobile-companion/` | App điện thoại: Expo SDK 58, React Native 0.88, expo-router, FlashList. Màn hình, trạng thái, client hợp đồng, module WebSocket native, test và harness e2e. |
| `packages/mobile-protocol/` | Hợp đồng wire có phiên bản dùng chung cho app và gateway: bảng op, bảng scope, mã đóng, helper cho pairing proof. Không import React Native hay Node, nên cả hai phía dùng được. |
| `plugins/mobile-gateway/` | Plugin phía Host: listener TLS, ghép đôi và sổ thiết bị, chính sách theo từng thiết bị, server giao thức, và lớp chiếu quyết định thiết bị được thấy gì. |
| `plugins/devices/` | Plugin trang Devices mà gateway đăng ký, để desktop liệt kê và thu hồi thiết bị. |
| `specs/` | Hồ sơ Spec Kit: hợp đồng, kế hoạch, task và bằng chứng nghiệm thu. |
| `tools/verify-publish.mjs` | Kiểm tra cây này có đầy đủ trước khi publish (xem mục Test). |

## Yêu cầu

- Host DeepSeek Harness ở `dsh-v0.2.2-rc.1`. Gateway khai báo `engines.dsh` và từ chối
  nạp trên Host khác phiên bản nó được build cho.
- Node 22+ cho gateway và test.
- Với app: toolchain Expo SDK 58. Cần máy thật hoặc emulator — app nói chuyện với socket
  thật và render bàn phím thật; xem trước trên trình duyệt sẽ không cho bạn sự thật.

## Cài gateway

Copy `plugins/mobile-gateway/` và `plugins/devices/` vào profile DSH khởi động, hoặc cài
như một bundle, rồi bật gateway. Nó chỉ nghe trên `127.0.0.1` cho tới khi bạn đổi địa chỉ
nghe từ trang Devices.

```bash
cd plugins/mobile-gateway
npm test          # suite độc lập; hai lần chạy có thể chồng nhau an toàn
```

## Build và chạy app

```bash
cd apps/mobile-companion
npm install
npm run typecheck
npm test          # node --test, không phụ thuộc framework test nào
node e2e/check-flows.mjs
npx expo run:android          # hoặc: npx expo run:ios
```

`android/` và `ios/` do `npx expo prebuild` sinh ra và không được commit: chúng chứa
đường dẫn tuyệt đối của máy đã sinh ra chúng.

## Ghép đôi điện thoại

1. Gateway đang chạy và Host tới được từ điện thoại (cùng LAN, hoặc một tunnel bạn tin).
2. Tạo lời mời ghép đôi trên Host với đúng các scope bạn định cấp. `sessions:read` và
   `prompt:send` là mức tối thiểu hữu ích; `sessions:author` là thứ cho phép điện thoại
   tạo phiên và đổi model.
3. Điện thoại quét hoặc nhận chuỗi ghép đôi, trả lời thách thức, rồi chờ.
4. Duyệt thiết bị đang chờ trên desktop. Không có bước duyệt thì không có gì hoạt động.

`harness:remote` chỉ dành cho desktop và bị bỏ qua một cách im lặng với điện thoại; điện
thoại không điều khiển Host của máy khác, chỉ Host này.

## Scope

| Scope | Cho phép |
|---|---|
| `sessions:read` | Liệt kê phiên và workspace, đọc hội thoại, theo dõi sự kiện. |
| `prompt:send` | Gửi chỉ dẫn tới một phiên. |
| `approval:respond` | Trả lời một thẻ phê duyệt. |
| `files:read` | Đọc file mà Host đưa ra. |
| `sessions:author` | Tạo phiên trong một workspace, liệt kê model, chọn model. |

Mọi thứ khác — tạo, đổi tên hay lưu trữ workspace, fork hay đổi tên phiên, settings,
commands, plugin, lịch, mục tiêu — bị từ chối với mọi thiết bị, theo tên, trên cả đường
typed lẫn bridge. Giao diện không bao giờ render những điều khiển đó.

`sessions:author` không bao giờ được cấp mặc định. Thiết bị chỉ có nó nếu lời mời yêu cầu
và chủ máy đã duyệt, và thu hồi có hiệu lực ngay ở request kế tiếp vì chính sách đọc lại
bản ghi thiết bị mỗi lần.

## Tới được từ máy khác

Không có gì nghe ngoài `127.0.0.1` trừ khi bạn bật, và bật nghĩa là TLS với chứng chỉ được
ghim. Điện thoại ghim dấu vân tay chứng chỉ nhận lúc ghép đôi; chứng chỉ đổi dưới chân nó
là lỗi cứng, không phải cảnh báo. Chúng tôi không kèm relay công khai, và không nhận URL
từ mạng.

## Cái này không làm gì

- Không chạy DSH trên điện thoại. Không PTY, không Node, không mã Host, không bao giờ.
- Không phải terminal. Nếu bạn muốn shell, đây không phải app đúng.
- Không sao chép giao diện desktop. Điện thoại hiện thứ điện thoại hiện hữu ích được;
  desktop vẫn là nơi mọi thứ đều có thể.
- Bản này chưa có thông báo đẩy. Cần credential APNs/FCM và bộ gửi phía server, cả hai
  chưa nằm trong cây này.
- Mới được kiểm chứng trên emulator Android với Host thật. Bản iOS build được, nhưng repo
  này không phát hành bản iOS đã ký.

## Test

```bash
node tools/verify-publish.mjs    # cây này đầy đủ: mọi import tương đối đều phân giải được
cd plugins/mobile-gateway && npm test && npm run test:package && npm run check:protocol
cd packages/mobile-protocol && npm test
cd apps/mobile-companion && npm run typecheck && npm test && node e2e/check-flows.mjs
```

Bộ test của app phủ controller, client hợp đồng, tỉ lệ tương phản của theme (tính toán,
cả hai scheme), và những nhánh lỗi dễ tái phát: thiếu quyền, tạo bị từ chối, chưa kết nối,
không lấy được danh sách model. Harness e2e chạy một gateway giả nói đúng hợp đồng và
khẳng định phía server rằng không có gì được gửi khi đáng lẽ không được gửi.

## Ghi công và giấy phép

Dự án này không thể có nếu thiếu hai dự án mã nguồn mở của **Clarklevis1995**. Xin cảm ơn tác giả đã
công bố chúng theo giấy phép MIT.

- **[Clarklevis1995/dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway)**
  (MIT, © 2026 Clarklevis1995) — `plugins/mobile-gateway/` là bản fork từ v0.12.0: listener TLS, sổ
  thiết bị, luồng ghép đôi và giao thức thiết bị đều lấy từ đây.
- **[Clarklevis1995/dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile)** (MIT, © 2026 Chaofan Li)
  — ứng dụng iOS/Android gốc mà màn hình, bố cục và cách tương tác của app này dựa theo, viết lại bằng
  React Native.

Cảm ơn [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), Host mà các extension này
chạy bên cạnh.

Repo này dùng giấy phép MIT. Xem [LICENSE](LICENSE) và [NOTICE.md](NOTICE.md) — nơi chép nguyên văn
giấy phép của các dự án gốc và ghi rõ đã lấy gì từ mỗi dự án.
