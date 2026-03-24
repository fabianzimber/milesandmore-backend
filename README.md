<div align="center">
  <h1>🛫 Miles & More • Backend</h1>
  <p><strong>The high-performance core engine for the Twitch interactive airline simulation.</strong></p>
</div>

---

## ✨ Overview

The **Miles & More Backend** powers the ultimate interactive flight simulation experience on Twitch. Built on modern Node.js and Fastify, this server orchestrates real-time IRC chat commands, manages flight telemetry, and handles job scheduling—all tightly integrated with Twitch and lightning-fast Redis storage.

## 🚀 Key Features

- **Twitch Integration Core:** Full IRC chat bot, user lookups, and Twitch API interactions.
- **Real-Time Data Pipelines:** Handles live SimLink aviation telemetry ingestion.
- **Automated Scheduling:** Upstash QStash and local pollers for boarding flows and lifecycle management.
- **Robust API Engine:** Lightweight Fastify endpoints serving the web frontend.

## 💻 Quick Start

### 1. Installation

```bash
npm install
```

### 2. Configuration

Copy the example environment variables and adjust them to your Twitch App/Bot and Upstash configurations:

```bash
cp .env.example .env
```

### 3. Development Server

Start the backend locally (listens on `http://localhost:3001` or your configured `PORT`):

```bash
npm run dev
```

## 📜 License & Credits

**Non-Commercial License**  
This project is licensed strictly for **non-commercial use**. You are free to view and modify the code for personal use or private testing, but you may not use this software, or any portion of it, for commercial purposes, monetization, or as part of a paid service.

**Requirements for Credits**  
If you showcase, adapt, or fork parts of this repository for open, non-profit projects, you **must prominently credit the original creator** in your project's `README.md` and user-facing documentation by linking back to this original code/author.

---
<div align="center">
  <sub>Built with ❤️ by Fabian Zimber / Shiftbloom Studio</sub>
</div>
