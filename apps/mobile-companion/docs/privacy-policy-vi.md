# DSH Orbit — Chính sách quyền riêng tư

> **BẢN NHÁP 2 (14-11-2026) — đang chờ địa chỉ công khai và duyệt lần cuối; chưa công bố.** Mọi
> khẳng định dưới đây đã đối chiếu với mã nguồn trong kho này; bảng *Cách kiểm chứng* ở cuối bản
> tiếng Anh ghi tệp cho từng điểm. Màn Quyền riêng tư trong ứng dụng (`app/privacy.tsx`) hiển thị bản
> rút gọn của cùng các nội dung đó, kèm phiên bản chính sách và địa chỉ liên hệ (`privacy.p10`).

**Ngày hiệu lực:** chưa đặt (sẽ đặt trên bản build gửi duyệt) · **Phiên bản:** NHÁP 2 · **Áp dụng
cho:** DSH Orbit, iOS và Android (`com.dshext.companion`), và bản web/PWA của cùng sản phẩm khi được
phục vụ từ địa chỉ Tailscale của một Host.

**Liên hệ:** developer@sunjin.vn

---

## 1. Ứng dụng này là gì

DSH Orbit là trình điều khiển cho **máy tính DeepSeek Harness (DSH) của chính bạn** ("Host"). Máy
tính làm việc: chạy agent, gọi model, chạy công cụ, và mọi thứ chạm tới tệp và mạng của bạn. Ứng dụng
ghép đôi với máy đó, liệt kê phiên, xem lịch sử và trả lời yêu cầu phê duyệt. Ứng dụng **không** chạy
mã của Host, Node, terminal (PTY) hay công cụ của agent trên điện thoại; nó chỉ hiển thị kết quả Host
gửi về và gửi quyết định của bạn trở lại.

Bạn không tạo tài khoản với chúng tôi. Không có đăng nhập vào dịch vụ của chúng tôi, và ứng dụng
không gửi gì tới máy chủ do nhà phát triển tự dựng.

## 2. Điện thoại kết nối tới Host thế nào — bản native

- Ứng dụng gọi địa chỉ trong mã ghép đôi bạn đã quét hoặc dán, và chỉ chấp nhận `wss://`.
- Chứng chỉ TLS được **ghim (pin) vào Host**: ứng dụng chỉ chấp nhận kết nối khi SHA-256 của chứng
  chỉ lá bằng giá trị trong mã ghép đôi. Không có đường lui sang nhà cung cấp chứng chỉ công cộng,
  không kiểm tra tên miền, không tin CA do người dùng cài, không có nút "chấp nhận không hợp lệ", không
  có HTTP thô. Khi không khớp, bắt tay TLS bị huỷ **trước khi** mã ghép đôi, mã thiết bị hay thông tin
  truy cập được gửi.
- Trên Android, cấu hình bảo mật mạng tin cậy **0** CA và tắt HTTP thô; trên iOS ứng dụng không cho
  phép tải tuỳ ý.

## 3. Bản web/PWA kết nối tới Host thế nào — yếu hơn, có chủ đích

Trình duyệt không thể soi chứng chỉ TLS trước khi thiết lập kết nối, nên bản web **không ghim** gì và
cũng không kiểm tra địa chỉ IP:

- Transport chỉ chấp nhận URL `wss://` có tên miền kết thúc bằng `.ts.net` (tên Tailscale); mọi địa chỉ
  khác bị từ chối trước khi mở socket.
- Sau đó chứng chỉ máy chủ được **chính trình duyệt kiểm tra TLS** theo kho nhà cung cấp chứng chỉ của
  nó — không phải bằng chứng chỉ lá đã ghim, và cũng không phải do ứng dụng này quyết định.
- Giá trị `certSha256` trong mã ghép đôi bị **bỏ qua** trên web. Nếu bạn ghép bản web bằng đúng mã
  dùng cho điện thoại, ghim không áp dụng ở đó.
- Trình duyệt không cho phép đặt header cho WebSocket, nên trên web mã thiết bị theo lần cài đặt đi
  như subprotocol `dsh-device.<id>` thay cho header `X-DSH-Device-ID`, và thông tin truy cập đi như
  subprotocol `dsh-auth.<token>`. Trình duyệt có thể ghi lại các giá trị bắt tay đó trong công cụ mạng
  của nó — coi hồ sơ trình duyệt đã ghép đôi là nơi giữ thông tin truy cập.

Nếu cần ghim, dùng ứng dụng iOS hoặc Android. Bản web dành cho origin Tailscale của chính Host.

## 4. Dữ liệu ứng dụng gửi đi, và đi đâu

| Dữ liệu | Đích | Khi nào |
|---|---|---|
| Bằng chứng ghép đôi và mã ghép đôi dùng một lần | Chỉ Host đã ghép, qua TLS (web: tới origin Tailscale của Host) | Khi ghép đôi |
| Mã thiết bị ngẫu nhiên theo lần cài đặt (UUID) | Host của bạn: header `X-DSH-Device-ID` trên native, subprotocol `dsh-device.<id>` trên web | Mỗi lần kết nối, để Host dùng lại bản ghi thiết bị tin cậy |
| Thông tin truy cập theo thiết bị do Host cấp | Lưu trên điện thoại (hoặc trình duyệt); gửi lại đúng Host đã ghép | Mỗi lần kết nối |
| Nội dung phiên — tiêu đề, lịch sử tin nhắn, câu lệnh bạn gửi, quyết định phê duyệt | Host của bạn, qua kết nối TLS | Khi bạn dùng ứng dụng |
| Vân tay chứng chỉ trong mã ghép đôi | Chỉ dùng tại máy, chỉ trên native; không bao giờ gửi đi | Khi kết nối native |

Vì vậy nội dung phiên và thông tin ghép đôi/truy cập chỉ đi tới **Host bạn đã ghép**. Đường phụ tuỳ
chọn duy nhất là thông báo trên web: nếu bạn bật, Host gửi thông điệp **đã mã hoá** nói ở phần 6 tới
dịch vụ đẩy của trình duyệt bạn. Ứng dụng không có phân tích hành vi, không SDK báo cáo sự cố, không
SDK quảng cáo và không thư viện theo dõi.

## 5. Dữ liệu được lưu, và mức bảo vệ

**iOS và Android (native):**

| Hạng mục | Nơi lưu | Cách xoá |
|---|---|---|
| Thông tin truy cập (theo từng Host) | Vùng lưu trữ mã hoá của nền tảng — nền Keystore trên Android, Keychain trên iOS. Trên iOS lưu với `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (chỉ đọc được khi thiết bị đã mở khoá, không chuyển sang thiết bị khác) | *Quên máy tính này* trong ứng dụng, hoặc thu hồi thiết bị trên Host |
| Mã thiết bị theo lần cài đặt | Cùng vùng mã hoá | Còn trên thiết bị này cho tới khi xoá mục đã lưu — xem quy tắc gỡ ứng dụng bên dưới (mất mã chỉ làm Host ghi nhận thiết bị mới) |
| Danh sách Host đã ghép (tên, địa chỉ, vân tay chứng chỉ) — không có thông tin truy cập | Cùng vùng mã hoá | *Quên máy tính này* |
| Nhật ký gỡ lỗi tuỳ chọn (có giới hạn, đã làm mờ; chỉ bản build bật cờ gỡ lỗi mới ghi) | Thư mục tài liệu riêng của ứng dụng | Cài đặt → Bộ nhớ đệm |
| Các tệp mà màn Bộ nhớ đệm liệt kê | Thư mục tài liệu riêng của ứng dụng | Cài đặt → Bộ nhớ đệm |

- Ứng dụng **không** tạo mục gắn với sinh trắc học trên Android: tuỳ chọn lưu trữ nó dùng không có
  `requireAuthentication` của Android, nên việc đọc thông tin truy cập không được Keystore tự chặn.
  Bước mở khoá là **cổng của chính ứng dụng** — ứng dụng yêu cầu sinh trắc học hoặc mật mã thiết bị và
  chỉ đọc thông tin truy cập sau khi xác thực thành công. Ai thao tác được kho đã mở khoá của thiết bị
  này thì đọc được dữ liệu trong đó; bảo vệ là khoá thiết bị cộng cổng của ứng dụng, không phải một
  hộp thoại sinh trắc học cho từng lần đọc.
- **Gỡ ứng dụng:** trên Android, gỡ ứng dụng sẽ xoá vùng lưu trữ nền Keystore, nên thông tin truy cập và
  mã thiết bị đi theo. Trên iOS, mục Keychain **có thể tồn tại sau khi gỡ**; hãy *Quên máy tính này*
  trước (thao tác đó xoá bản ghi Host rồi cố xoá thông tin truy cập theo đúng khoá đó), hoặc thu hồi
  thiết bị trên Host — thu hồi gỡ quyền truy cập, làm mục còn lại không dùng được.
- Ứng dụng chỉ xin quyền camera (quét mã QR ghép đôi), sinh trắc học / mật mã thiết bị (mở khoá), và
  thông báo. Không có quyền thư viện ảnh, danh bạ hay tệp chung.

**Web/PWA:**

| Hạng mục | Nơi lưu | Cách xoá |
|---|---|---|
| Thông tin truy cập, dưới dạng bản mã AES-GCM | IndexedDB của trình duyệt. Khoá AES-256 bọc dữ liệu là **không thể xuất** (script trong trang không lấy được khoá), nhưng khoá nằm **cùng một IndexedDB** với bản mã | *Quên máy tính này* yêu cầu ứng dụng xoá tại máy (nỗ lực tốt nhất); xoá dữ liệu trang là cách xoá chắc chắn |
| Danh sách Host đã ghép, dạng JSON không mã hoá | Cùng IndexedDB | *Quên máy tính này* (nỗ lực tốt nhất), hoặc xoá dữ liệu trang |
| Mã thiết bị theo lần cài đặt | `localStorage` | Xoá dữ liệu trang |

Kho trên web **yếu hơn Keychain/Keystore có chủ đích**: không có phần cứng bảo vệ, không tách riêng
theo ứng dụng, không gắn với việc mở khoá thiết bị. Ai đọc được hồ sơ trình duyệt (hoặc chạy được
script trong origin đó) đều có thể giải mã thông tin truy cập đã lưu; hồ sơ trình duyệt chính là ranh
giới bảo mật. Gỡ một PWA **không** bảo đảm trình duyệt đã xoá dữ liệu trang, nên sau bản web hãy *Quên
máy tính này* trong ứng dụng **và** xoá dữ liệu trang trong trình duyệt.

Mở khoá trên web, khi Host cấp quyền đó, không phải hộp thoại sinh trắc học của điện thoại: Host gửi
thử thách và trình duyệt trả lời bằng passkey đã đăng ký cho lần ghép đôi đó.

## 6. Thông báo

**Native (iOS/Android): chỉ cục bộ.** Ứng dụng tự tạo thông báo trên điện thoại khi kết nối đang mở
báo có yêu cầu phê duyệt. Nội dung gồm một dòng cố định ngắn, tên công cụ (một từ cố định trong bộ từ
vựng công cụ, không phải nội dung của bạn), và các mã định danh — phiên, phê duyệt, yêu cầu — kèm
đường dẫn sâu mà lần chạm sẽ mở. Thông báo **không** mang tham số của yêu cầu phê duyệt, đầu vào của
công cụ, nội dung tin nhắn hay thông tin truy cập. Ứng dụng không đăng ký token đẩy từ xa với Apple
(APNs) hay Google (FCM); không có dịch vụ đẩy nào của chúng tôi. Vì ứng dụng đóng socket đã xác thực
khi xuống nền, thông báo chỉ có thể được tạo khi ứng dụng đang chạy.

**Web (PWA): tuỳ chọn, và có rời khỏi trình duyệt.** Nếu bạn bật thông báo trong Cài đặt, trình duyệt
tạo một đăng ký đẩy và ứng dụng trao cho Host của bạn **endpoint** của đăng ký (một URL tại origin
dịch vụ đẩy — dịch vụ đẩy do Google, Apple, Mozilla, Microsoft hoặc hãng trình duyệt bạn dùng vận
hành) cùng hai khoá của đăng ký. Host của bạn sau đó gửi tới dịch vụ đẩy đó một thông điệp **đã mã
hoá**, mà toàn bộ nội dung dạng rõ là `{ v, kind, sessionId, requestId? }` — số phiên bản, loại sự kiện
(`approval`, `question`, `session-finished`), mã phiên, và với hai loại cần tương tác là mã yêu cầu.
Nội dung thông báo cố định (tiếng Anh hoặc tiếng Việt, theo ngôn ngữ trình duyệt) do service worker của
ứng dụng viết trên máy, không nằm trong thông điệp.

Vì vậy dịch vụ đẩy (Google, Apple, Mozilla, Microsoft hoặc hãng trình duyệt của bạn) thấy **siêu dữ
liệu giao nhận** của thông điệp đó: danh tính đẩy của Host bạn, endpoint và thời điểm giao, cộng những
gì nhà cung cấp tự ghi. Nó **không** nhận nội dung thông điệp ở dạng đọc được (payload được mã hoá bằng
khoá của đăng ký), và hoàn toàn không nhận tiêu đề phiên, câu lệnh hay tham số phê duyệt.

**Tắt thông báo** gồm hai lần thử: ứng dụng báo Host của bạn quên đăng ký này (huỷ phía Host), rồi ứng
dụng cố huỷ chính đăng ký trong trình duyệt. Bước nào cũng có thể thất bại.

***Quên máy tính này*** chỉ xoá ghép đôi tại máy, và đó là nỗ lực tốt nhất. **Thu hồi thiết bị trên
Host** chặn **các lần gửi về sau**: nó gỡ quyền truy cập và gỡ đăng ký đã lưu trên Host, nên từ đó Host
không tạo thêm thông báo nào cho thiết bị này. Những gì dịch vụ đẩy đã nhận hay đã xếp hàng trước đó vẫn
có thể tới trình duyệt, và dịch vụ đẩy có thể giữ hồ sơ các lần giao cũ theo chính sách của chính họ.

## 7. Build và phát hành

Văn bản này nói về lúc ứng dụng chạy, không nói về cách build hay phân phối. Việc build và phát hành
dùng công cụ đám mây của Expo (EAS) và App Store của Apple hoặc Google Play; nếu có bản build cho cửa
hàng, các nhà cung cấp đó thấy bản build và tự tạo chẩn đoán cửa hàng/sự cố của họ, theo **chính sách
của họ**, và những gì nhà phát triển nhận được từ bảng điều khiển của họ tuỳ nhà cung cấp.

## 8. Quyền kiểm soát của bạn

- **Thu hồi thiết bị trên Host** kết thúc ở phía Host: quyền truy cập bị gỡ và đăng ký phía Host bị xoá,
  nên từ đó không còn lần gửi nào được tạo ra. Ứng dụng xoá thông tin truy cập nó đang giữ (và kiểm tra
  lại việc xoá).
- ***Quên máy tính này*** trong ứng dụng: xoá bản ghi Host đã ghép rồi mới cố xoá thông tin truy cập
  theo đúng khoá đó — kể cả thông tin còn lại từ lần cài iOS trước đó. Nếu không xoá được, ứng dụng báo
  lỗi dọn dẹp chứ không cho rằng đã xoá xong. Nó không ngắt ghép đôi gì trên Host.
- **Tắt thông báo trên web**: ứng dụng báo Host quên đăng ký, rồi cố huỷ đăng ký trong trình duyệt
  (phần 6).
- **Xoá dữ liệu trang của trình duyệt** sau *Quên* trên bản web, vì chỉ gỡ ứng dụng là không đủ.
- **Xoá nhật ký gỡ lỗi và các tệp liệt kê** ở Cài đặt → Bộ nhớ đệm; việc này không làm mất ghép đôi.
- **Gỡ ứng dụng:** trên Android vùng lưu trữ mã hoá và tệp riêng đi theo; trên iOS mục Keychain có thể
  tồn tại sau khi gỡ — xem phần 5.

## 9. Trẻ em

Ứng dụng là trình điều khiển cho một công cụ lập trình và không hướng tới trẻ em. Nhà phát triển không
cố ý thu thập thông tin cá nhân của bất kỳ ai thông qua ứng dụng, kể cả trẻ em; ứng dụng vốn không có
đường "thu thập" nào — nó nói chuyện với Host của chính bạn.

## 10. Bảo mật

Thông tin truy cập nằm trong vùng lưu trữ mã hoá của nền tảng (native) hoặc kho IndexedDB đã mã hoá
như phần 5 (web); không bao giờ được ghi vào nhật ký hay thông báo. Trên native, kết nối ghim chứng chỉ
của Host; trên web, transport chỉ chấp nhận `wss://` tới tên miền `.ts.net` và chứng chỉ do trình duyệt
kiểm tra (phần 3). Quyết định phê duyệt gắn với đúng yêu cầu đang hiển thị: một quyết định chỉ áp dụng
một lần, và yêu cầu đã thay đổi sau khi hiển thị thì bị từ chối.

## 11. Thay đổi chính sách

Khi một tính năng làm thay đổi bất kỳ điểm nào ở trên, văn bản này và màn Quyền riêng tư trong ứng
dụng thay đổi trong cùng bản phát hành, kèm dòng phiên bản và ngày mới.

## 12. Liên hệ

**developer@sunjin.vn**

---

Bảng đối chiếu mã nguồn (*How this was verified*) nằm ở bản tiếng Anh,
`docs/privacy-policy-en.md`.
