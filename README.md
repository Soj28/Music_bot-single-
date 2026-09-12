# Discord Music Bot

Discord Music Bot được xây dựng bằng Node.js và Discord.js.

## ✨ Tính năng

* 🎵 Phát nhạc trong voice channel
* ⏯️ Play / Pause
* ⏭️ Skip
* 🔁 Loop
* 🔀 Shuffle
* 📜 Queue
* 🔊 Điều chỉnh âm lượng
* 🎛️ Bộ lọc âm thanh
* 🤖 Tự động tham gia voice channel theo cấu hình
* 💾 Lưu cấu hình voice channel
* ⚡ Slash Commands

## 🛠️ Công nghệ

* Node.js
* Discord.js
* JavaScript
* FFmpeg
* Opus

## 📋 Yêu cầu

* Node.js
* npm
* FFmpeg
* Discord Bot Token

## 📥 Cài đặt

Clone repository:

```bash
git clone https://github.com/Soj28/Music_bot-single-.git
cd Music_bot-single-
```

Cài đặt các package:

```bash
npm install
```

## 🔐 Cấu hình

Tạo file `.env` trong thư mục project:

```env
TOKEN=YOUR_DISCORD_BOT_TOKEN
```

**Không chia sẻ hoặc upload file `.env` lên GitHub.**

File `.env` đã được thêm vào `.gitignore`.

## ▶️ Chạy bot

```bash
npm start
```

Hoặc nếu project không có script `start`:

```bash
node index.js
```

## 📁 Cấu trúc project

```text
Music bot (single)/
├── index.js
├── package.json
├── package-lock.json
├── README.md
├── .gitignore
├── voice-config.json
├── .env
└── node_modules/
```

> `.env` và `node_modules/` không được đưa lên GitHub.

## 🔒 Bảo mật

Không đưa các thông tin sau lên GitHub:

* Discord Bot Token
* API Key
* Password
* Secret Key
* File `.env`

Nếu Bot Token đã bị công khai, hãy reset token trong Discord Developer Portal.

## 📄 License

MIT License.
