# Ecom Video Drop

Ứng dụng Desktop chuyển video AI (**OpenArt**, **Google Flow**, **OBS**) trực tiếp từ máy tính **Windows / macOS** sang **Ảnh (Photos)** trên **iPhone** qua mạng **Wi-Fi nội bộ** để đăng TikTok — loại bỏ hoàn toàn bước trung gian upload/download qua Google Drive.

---

## Tải & Cài đặt cho người dùng (GitHub Releases)

Truy cập trang **[Tải bản mới nhất tại GitHub Releases](https://github.com/LuanTruongPTIT/tool-transfer-video/releases/latest)** để tải bộ cài đặt có sẵn biểu tượng ngoài màn hình:

- **Windows 10 / 11 (64-bit):**
  - Tải **`Ecom-Video-Drop-Setup-1.0.0.exe`** &rarr; bấm đúp để cài đặt (không cần quyền Admin), tự động tạo biểu tượng **Ecom Video Drop** ngoài màn hình **Desktop** và trong **Start Menu**.
  - *(Hoặc tải `Ecom-Video-Drop-Portable-1.0.0.exe` nếu muốn bản chạy ngay 1 file không cần cài).*
  - **Lưu ý lần đầu mở trên Windows:** Khi hiện bảng xanh *Windows protected your PC*, bấm **More info (Thêm thông tin)** &rarr; chọn **Run anyway (Vẫn chạy)**.
- **macOS (Apple Silicon M1/M2/M3/M4 & Intel):**
  - Tải **`Ecom-Video-Drop-1.0.0-mac-arm64.dmg`** (chip dòng M) hoặc **`x64.dmg`** (chip Intel) &rarr; mở lên và kéo biểu tượng vào thư mục `Applications`.
  - **Lưu ý lần đầu mở trên macOS:** Giữ `Control` + Click chuột phải vào ứng dụng trong `Applications` &rarr; chọn **Open (Mở)**.

---

## 3 Chế độ chuyển video sang Ảnh (Photos) trên iPhone

### 1. Chế độ AirDrop 0 chạm — Tự bắn thẳng vào Ảnh (LocalSend Protocol v2)
- Cài một lần ứng dụng miễn phí **LocalSend** trên App Store iPhone.
- Trong **Cài đặt (Settings)** của LocalSend trên iPhone: bật **Lưu nhanh (Quick Save)** và bật **Lưu tệp phương tiện vào thư viện**.
- Trên **Ecom Video Drop** (tab **AirDrop 0 chạm**): bấm **Quét tìm iPhone** &rarr; chọn iPhone của bạn &rarr; bật **Tự động bắn khi có video mới (Auto-Push)** (hoặc bấm nút **Bắn sang iPhone** trên từng video).
- Kể cả file quay màn hình `.mkv` cũng được tự động chuyển vỏ sang `.mp4` trước khi bắn để chui thẳng vào **Ảnh (Photos)** trên iPhone mà không cần chạm tay.

### 2. Chế độ Phím tắt 1 chạm & Nút ngoài Màn hình chính (Apple Shortcuts)
- Không cần cài app bên thứ ba trên iPhone — dùng ngay ứng dụng **Phím tắt (Shortcuts)** có sẵn của Apple.
- Quét QR ghép đôi 1 lần trên Safari, tạo phím tắt tên **`Ecom Video Drop`** gồm đúng 3 lệnh (*Lấy các URL từ Đầu vào Phím tắt* &rarr; *Lấy nội dung của URL* &rarr; *Lưu vào Album ảnh*) theo hướng dẫn ngay trên màn hình iPhone (mất 20 giây) hoặc tải qua link iCloud Shortcut của team.
- Bấm **Lưu thẳng vào Ảnh (1 chạm)** trên từng video, **Hút tất cả video mới vào Ảnh**, hoặc bấm **Gắn ra MH chính** để tạo icon **Hút Video** ngay ngoài màn hình chính iPhone.

### 3. Chế độ Safari chuẩn (0 cài đặt)
- Mở trực tiếp bằng **Camera iPhone + trình duyệt Safari**, hỗ trợ xem trước mượt mà (`HTTP 206 Partial Content`), tải file gốc và tách biệt rõ trạng thái **`Ở Safari (Chờ lưu Ảnh)`** với **`Đã vào Ảnh (Photos)`**.

---

## Phát hành phiên bản mới lên GitHub Releases

Dự án đã cấu hình sẵn workflow tự động tại `.github/workflows/release.yml` cùng bộ biểu tượng đa nền tảng trong `build/` (`icon.ico`, `icon.icns`, `icon.png`).

Mỗi khi muốn phát hành bản mới (ví dụ `v1.0.1`), chỉ cần gắn thẻ phiên bản và đẩy lên GitHub:

```bash
git tag v1.0.1
git push origin v1.0.1
```

Đợi khoảng 3–4 phút trong tab **Actions** trên GitHub, trang **[Releases](https://github.com/LuanTruongPTIT/tool-transfer-video/releases)** sẽ tự động xuất hiện đầy đủ bộ cài `Ecom-Video-Drop-Setup-*.exe` (Windows) và `.dmg` (macOS) cho mọi người tải về!
*(Hoặc vào tab **Actions &rarr; Build & Publish Desktop Release &rarr; Run workflow** để phát hành trực tiếp trên giao diện web).*

---

## Phát triển tại máy cục bộ (Dev)

```bash
npm install
npm test
npm start
```
