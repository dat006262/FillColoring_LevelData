---
name: fillcoloring-level-pipeline
description: Quy trình tự động tạo bộ level tô màu 5 bước (Google AI Studio, Canva, Gemini) từ tranh màu gốc đến bộ 5 file ảnh hoàn chỉnh xuất ra thư mục output. Sử dụng khi người dùng yêu cầu tạo level mới, chạy tự động 5 bước, hoặc điều khiển pipeline tranh màu và line art.
---

# Quy Trình Tạo Level Tô Màu Tự Động (FillColoring Studio Pipeline)

Quy trình chuẩn hóa 5 bước tạo dữ liệu level tô màu hoàn chỉnh cho game/ứng dụng, kết hợp **Google AI Studio**, **Canva**, và **Gemini** thông qua **FillColoring Studio** và **FillColoring Browser Bridge (Chrome Extension)**.

---

## 1. Tổng quan 5 bước xử lý

```
[Prompt chữ]
     │
     ▼
┌────────────────────────┐
│ Bước 1: Tranh màu gốc  │ ---> [picture_name]_colored_origin.png
│ (Google AI Studio)     │      Ảnh màu vuông 1024 × 1024 px
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ Bước 2: Tạo nét cơ bản │ ---> [picture_name]_line_notpatch.png
│ (Canva - Khớp định dạng)│      Nghệ thuật đường nét (Line art)
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ Bước 3: Vá kín nét hở  │ ---> [picture_name]_line_pathched.png
│ (Gemini trên web)      │      Nối kín các vùng hở để chuẩn bị tô màu
└──────────┬─────────────┘
           │
     ┌─────┴─────────────────────────┐
     ▼                               ▼
┌─────────────────────────┐   ┌──────────────────────────┐
│ Bước 4: Tô màu lại      │   │ Bước 5: Xóa nền line     │
│ (Google AI Studio)      │   │ (Thuật toán cục bộ)      │
└──────────┬──────────────┘   └──────────┬───────────────┘
           │                             │
           ▼                             ▼
[picture_name]_colored_final.png  [picture_name]_line_final.png
```

---

## 2. Quy ước đặt tên file và Thư mục xuất (Output)

Tất cả các file xuất ra đều tuân thủ nghiêm ngặt quy ước trong tài liệu `doc/Quy trình tạo level thủ công - Biên tập.docx` và thư mục mẫu `example/`:

| Bước | Tên phiên bản | Hậu tố file (Suffix) | Quy ước tên file đầy đủ |
| :--- | :--- | :--- | :--- |
| **01** | Tranh màu gốc | `_colored_origin` | `[picture_name]_colored_origin.png` |
| **02** | Line Canva chưa vá | `_line_notpatch` | `[picture_name]_line_notpatch.png` |
| **03** | Line đã vá nét | `_line_pathched` | `[picture_name]_line_pathched.png` |
| **04** | Tranh màu hoàn thiện | `_colored_final` | `[picture_name]_colored_final.png` |
| **05** | Line nét đen xóa nền | `_line_final` | `[picture_name]_line_final.png` |

- **Thư mục xuất chính thức**: `F:\noichuagit\FillColoring_LevelData\output`
- **Ví dụ tham khảo chuẩn**: `F:\noichuagit\FillColoring_LevelData\example`

---

## 3. Cách chạy công cụ

### Khởi động Server & Mở Studio
Chạy file khởi động từ thư mục gốc dự án:
```powershell
& ".\Mở FillColoring Studio.cmd"
```
Hoặc mở thủ công bằng Python:
```powershell
& "python" "level-tool\server.py" --port 8765
```
Giao diện Studio sẽ mở tại địa chỉ: `http://127.0.0.1:8765`

### Cài đặt Tiện ích Chrome (Browser Bridge)
1. Mở Chrome, truy cập `chrome://extensions`.
2. Bật **Developer mode** (Chế độ dành cho nhà phát triển).
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén) và chọn thư mục:
   `F:\noichuagit\FillColoring_LevelData\level-tool\chrome-extension`
4. Giữ tab Studio mở trong Chrome để duy trì kết nối với extension.

---

## 4. Chế độ Chạy một mạch từ Bước 1 → Bước 5 (⚡ 1-Click All)

Khi người dùng muốn sinh trọn bộ 5 ảnh hoàn chỉnh từ đầu:
1. Bấm nút **"＋ Tạo mới / Nhập ảnh"** -> Nhập tên tranh (ví dụ: `landscape_phoenix`), để trống phần file ảnh -> Bấm **"Tạo tranh"**.
2. Nhập mô tả tranh vào ô prompt Bước 1 (hoặc giữ prompt mặc định).
3. Bấm nút nổi bật: **`⚡ Chạy tự động 5 bước (Xuất 5 ảnh)`** (trên thanh Header hoặc Action Bar).
4. Hệ thống sẽ tự động thực hiện:
   - **Bước 1**: Mở AI Studio, gửi prompt sinh tranh màu 1024x1024, lấy ảnh về.
   - **Bước 2**: Mở Canva, xóa ảnh cũ (DEL), kéo ảnh mới vào, đổi cỡ vừa vùng chọn, mở Chỉnh sửa, áp dụng "Nghệ thuật đường nét", tải về `_line_notpatch.png`.
   - **Bước 3**: Mở Gemini, tải ảnh line lên, gửi prompt vá nét kín, nhận về `_line_pathched.png`.
   - **Bước 4**: Mở AI Studio, tải ảnh line đã vá lên, gửi prompt tô màu, nhận về `_colored_final.png`.
   - **Bước 5**: Tự động xóa nền trắng, giữ nét đen khử răng cưa mượt mà, lưu thành `_line_final.png`.
   - **Xuất file**: Tự động lưu toàn bộ 5 file ảnh vào `F:\noichuagit\FillColoring_LevelData\output`.

---

## 5. Chế độ Chạy từng bước riêng biệt (Thủ công / Kiểm soát)

Người dùng có thể chạy riêng bất kỳ bước nào bằng các nút tương ứng trong Studio:
- **Tạo ảnh AI Studio** (Bước 1): Sinh lại tranh màu gốc.
- **Tạo line qua Canva** (Bước 2): Xuất nét đen cơ bản.
- **Vá nét bằng Gemini** (Bước 3): Vá các nét hở, sau đó bấm *"Duyệt line"*.
- **Tô màu bằng AI Studio** (Bước 4): Tô màu lại từ line đã duyệt, sau đó bấm *"Duyệt màu"*.
- **Xóa nền** (Bước 5): Tạo ảnh PNG nét đen nền trong suốt.
- **Xuất bộ ảnh ra Output**: Bấm nút xuất bất kỳ lúc nào để cập nhật 5 file ra thư mục output.

---

## 6. Xử lý sự cố thường gặp (Troubleshooting)

1. **Canva không tự động đổi cỡ khung vẽ**:
   - Tiện ích tự động tìm nút `...` (Tùy chọn khác) trên thanh công cụ nổi của ảnh để mở menu ngữ cảnh, sau đó click dòng *"Đổi cỡ khung vẽ cho vừa với vùng chọn"*. Nếu không có tài khoản Canva Pro, tiện ích tự động dùng *"Đặt hình ảnh làm nền"*.
2. **Ảnh nét Canva thanh mảnh không được nhận**:
   - Hệ thống đã cấu hình bộ lọc chấp nhận dải xám khử răng cưa `hist[:140]`. Khi Chrome tải file PNG về `Downloads`, server Python sẽ tự động phát hiện và nạp thẳng vào Studio.
3. **Mất kết nối tiện ích**:
   - Kiểm tra xem tab Studio (`http://127.0.0.1:8765`) có đang mở trong cùng trình duyệt Chrome đã cài tiện ích hay không.
