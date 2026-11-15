# FillColoring Studio

Công cụ chạy trên máy Windows để quản lý ảnh level, vá nét qua Gemini, tô màu qua Google AI Studio và xóa nền line tại máy. Bạn tiếp tục tạo line trong Canva như trước.

Công cụ hỗ trợ 2 chế độ xử lý AI:
1. **Google trên Chrome (Mặc định & Khuyến nghị)**: Dùng trực tiếp phiên đăng nhập Google sẵn có trên trình duyệt Chrome thông qua tiện ích mở rộng cục bộ đi kèm.
   - **Vá nét (Bước 3):** Chạy tự động qua **Gemini Web**.
   - **Tô màu (Bước 4):** Chạy tự động qua **Google AI Studio** với đúng prompt template bạn đã lưu!
   - Không cần API key, không tốn chi phí API, không chia sẻ mật khẩu hay cookie.
2. **Gemini API**: Dùng API key trực tiếp từ Google AI Studio với model được cấp quyền.

---

## Mở công cụ

1. Nhấp đúp file **`Mo FillColoring Studio.cmd`** ở thư mục gốc dự án.
2. Giao diện Studio tự động mở tại `http://127.0.0.1:8765`. Nếu chạy launcher lần nữa, nó sẽ mở lại phiên đang chạy mà không tạo thêm tiến trình trùng lặp. Công cụ chỉ lắng nghe kết nối cục bộ trên máy này.

Launcher ưu tiên Python và Pillow đi kèm runtime trên máy. Trên máy khác, cài Python 3.10 trở lên có Pillow (`python -m pip install -r requirements.txt`). Có thể đặt biến môi trường `FILLCOLORING_PYTHON` trỏ tới file `python.exe` muốn dùng.

---

## Thiết lập một lần: Kết nối Chrome

Để sử dụng phiên đăng nhập Google sẵn có cho cả Gemini và Google AI Studio mà không cần API key:

1. **Cài tiện ích mở rộng vào Chrome:**
   - Trong Google Chrome (profile đã đăng nhập tài khoản Google bạn muốn dùng), truy cập: `chrome://extensions`
   - Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
   - Nhấp vào nút **Load unpacked** (Tải tiện ích đã giải nén).
   - Chọn thư mục: `F:\noichuagit\FillColoring_LevelData\level-tool\chrome-extension` (hoặc thư mục con `level-tool\chrome-extension` của dự án).
   - *(Nếu đã cài trước đó, chỉ cần bấm biểu tượng **Reload 🔄** trên thẻ tiện ích).*
2. **Cấu hình trong Studio:**
   - Mở Studio tại `http://127.0.0.1:8765` trên cùng trình duyệt Chrome đã cài tiện ích.
   - Bấm nút **⚙ Cài đặt xử lý** ở góc dưới thanh bên trái.
   - Tại mục *Cách xử lý ảnh*, chọn **Gemini trên Chrome — không dùng API key**.
   - **URL Gemini vá nét (Bước 3):** ví dụ `https://gemini.google.com/u/2/app` hoặc `https://gemini.google.com/app`.
   - **URL AI Studio tô màu (Bước 4):** ví dụ link prompt của bạn: `https://aistudio.google.com/u/2/prompts/1wN9BKl3arwh3KcwLRU01EaNeB7JoSw7o`.
   - **Email Google:** nhập email tài khoản của bạn (ví dụ: `mongnangthoi@gmail.com`). Tiện ích sẽ đối chiếu đúng email này trước khi gửi ảnh để đảm bảo không gửi nhầm tài khoản.
   - Bấm **Lưu cài đặt**.
   - Thanh thông báo trên màn hình sẽ chuyển sang: **Chrome đã kết nối · Gemini web · Không dùng API key**.

*(Xem thêm hướng dẫn chi tiết tại trang `/browser-help`)*.

---

## Quy trình hằng ngày

1. **Xuất ảnh từ Canva**: Tạo ảnh line trong Canva và tải về máy như bình thường (đặt tên dạng `[picture_name]_line_notpatch.png`).
2. **Nhập ảnh line**: Trong Studio, chọn **Nhập ảnh line**. Có thể chọn nhiều file cùng lúc để nhập hàng loạt; mỗi file sẽ tạo một tranh riêng biệt. Tên tranh tự động lấy từ tên file và bỏ hậu tố `_line_notpatch` nếu có.
3. **Vá nét bằng Gemini (Bước 03)**:
   - Chọn một tranh trong thư viện, bấm **Vá nét bằng Gemini**.
   - Tiện ích Chrome sẽ tự động mở tab Gemini riêng, kiểm tra tài khoản, mở menu `+` và nạp ảnh, điền prompt vá nét và chờ ảnh kết quả.
   - Khi hoàn tất, ảnh sẽ tự động chuyển về Studio. Mở tab **Line đã vá**, bấm **Xem lớn** kiểm tra và bấm **Duyệt line**.
4. **Chạy bước 4 + 5 (Tô màu AI Studio & Xóa nền máy)**:
   - Bấm nút **Chạy bước 4 + 5**.
   - Công cụ sẽ tự động **Xóa nền line** (Bước 05) trực tiếp tại máy tính trước bằng Pillow (giữ nét đen sắc nét, nền trong suốt).
   - Đồng thời tự động mở tab **Google AI Studio** với đúng prompt mẫu của bạn để **Tô màu** (Bước 04), gắn ảnh line đã duyệt và bấm Run.
   - Kết quả ảnh màu tự động lấy về Studio. Nếu AI Studio gặp trục trặc, ảnh line trong suốt đã tạo vẫn được giữ nguyên an toàn.
5. **Kiểm tra và duyệt màu**:
   - Mở tab **Chồng kiểm tra** để so sánh đường nét đỏ với ảnh màu.
   - Kéo thanh trượt *Độ đậm nét kiểm tra* để kiểm tra khớp nét.
   - Bấm **Xem lớn** kiểm tra chi tiết, sau đó bấm **Duyệt màu** khi đạt yêu cầu.
6. **Xuất bộ ảnh**:
   - Bấm **Xuất bộ ảnh**.
   - Bấm **Mở thư mục** để nhận bộ ảnh hoàn chỉnh gồm:
     - `[picture_name]_line_final.png` (ảnh nét trong suốt)
     - `[picture_name]_colored_final.png` (ảnh màu hoàn chỉnh)
     - `manifest.json` (ghi nhận kích thước, phiên bản nguồn)

> **Mẹo**: Nếu bạn có sẵn ảnh đã xử lý từ bên ngoài (ví dụ tự vá nét hoặc tự tô màu ngoài Studio), ở tab **Line đã vá** hoặc **Ảnh màu** có nút **Nhập kết quả có sẵn** để nạp thẳng vào phiên bản mới mà không cần chạy lại AI.

---

## File và phiên bản lưu trữ

Dữ liệu của Studio được lưu riêng tại `level-tool/data/projects/<mã tranh>/`. Hoàn toàn không đụng chạm hay thay đổi các ảnh gốc ở ngoài thư mục công cụ.

- `project.json`: Lưu trạng thái, danh sách các phiên bản và các bản đã duyệt.
- `assets/`: Lưu trữ các file PNG của từng bước, đánh số phiên bản (`v1`, `v2`,...); không ghi đè kết quả cũ.
- `raw/`: Lưu ảnh gốc AI trả về trước khi chuẩn hóa kích thước, giữ lại phòng trường hợp cần đối chiếu.
- `exports/<thời điểm>_<mã>/`: Thư mục xuất file chính thức.
- `last-error.json`: Ghi nhận lỗi gần nhất để dễ tra cứu.

Khi tắt tab trình duyệt, server vẫn tiếp tục chạy trên máy. Khi khởi động lại server, toàn bộ trạng thái duyệt và lịch sử phiên bản đều được khôi phục nguyên vẹn từ đĩa.

---

## Dọn dẹp dữ liệu

Công cụ cung cấp 3 tính năng dọn dẹp để quản lý dung lượng ổ cứng và thư viện tranh:
1. **Xóa tranh đang chọn:** Bấm nút **🗑 Xóa tranh** ở góc trên bên phải (cạnh nút *Mở thư mục*). Thao tác này sẽ xóa toàn bộ phiên bản của bức tranh đó khỏi thư viện.
2. **Dọn dẹp file thô (raw):** Trong **⚙ Cài đặt xử lý** → mục *Dọn dẹp dữ liệu* → bấm **🧹 Dọn dẹp file thô (raw)**. Thao tác này sẽ dọn sạch các file ảnh tạm do AI tải về (trong thư mục `raw/`) để giải phóng hàng trăm MB ổ cứng, mà vẫn giữ an toàn 100% các phiên bản tranh và kết quả xuất.
3. **Xóa tất cả tranh trong thư viện:** Trong **⚙ Cài đặt xử lý** → bấm **Xóa tất cả tranh trong thư viện** để xóa trắng thư viện và bắt đầu lại từ đầu khi cần.

---

## Tùy chọn chế độ Gemini API (Có tính phí)

Nếu bạn muốn chuyển sang dùng Gemini API thay vì giao diện Chrome:
1. Vào **Cài đặt xử lý**, chọn cách xử lý là **Gemini API**.
2. Nhập API key của bạn từ Google AI Studio và chọn model tạo ảnh (`gemini-nano-banana-2.1`, `gemini-3.1-flash-image`,...).
3. API key mặc định chỉ lưu trong bộ nhớ tiến trình. Bạn có thể bật **Nhớ khóa trên tài khoản Windows này** để mã hóa an toàn qua Windows DPAPI (lưu tại `data/api-key.dpapi`). Nút **Quên API key** sẽ xóa ngay khóa lưu và trong bộ nhớ.
4. Cũng có thể truyền qua biến môi trường `GEMINI_API_KEY`.

---

## Cơ chế an toàn và xử lý sự cố

- **Kiểm tra tài khoản nghiêm ngặt**: Tiện ích đối chiếu email trước khi gửi ảnh. Nếu tab mở sai tài khoản Google, tiện ích sẽ dừng ngay và báo lỗi, không gửi ảnh.
- **Không tự ý chuyển chế độ**: Nếu gặp lỗi trên Chrome, công cụ **không bao giờ tự động chuyển sang API có phí** để tránh phát sinh chi phí ngoài ý muốn của bạn.
- **Không gửi lại prompt trùng lặp**: Tránh việc tiện ích gửi nhiều lần làm tốn hạn mức của bạn.
- **Hủy tác vụ**: Khi đang chờ xử lý, bạn có thể bấm **Hủy chờ trình duyệt** bất kỳ lúc nào để dừng nhận ảnh trong Studio.
- **Khi AI yêu cầu tương tác (CAPTCHA / Đăng nhập lại / Hết hạn mức)**: Hãy chuyển sang tab đang mở để hoàn thành xác thực hoặc kiểm tra thông báo. Bạn có thể tự tải ảnh về rồi dùng tính năng **Nhập kết quả có sẵn** trên Studio.
- **Xóa nền cục bộ**: Thuật toán xóa nền được tối ưu cho nét đen trên nền trắng: độ tối trở thành kênh alpha của nét đen, giữ viền chuyển sắc tự nhiên và làm trong suốt vùng nền trắng.

---

## Chạy trực tiếp và kiểm thử

Chạy server bằng dòng lệnh:
```powershell
python server.py --no-browser --port 8765
```

Chạy toàn bộ bộ kiểm thử tự động (21 tests):
```powershell
python -m unittest discover -s tests -v
```
*(Nếu chạy từ thư mục gốc, gán `PYTHONPATH=./level-tool` trước khi chạy unittest)*.
