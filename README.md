# 🎵 SyncTune

**Listen to music together in real-time.** Create a room, share a 6-digit code, and enjoy perfectly synchronized audio with friends.

![Node.js](https://img.shields.io/badge/Node.js-20-green?logo=node.js)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.7-blue?logo=socket.io)
![License](https://img.shields.io/badge/License-MIT-purple)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/winbtnew3-del/synctune)

## ✨ Features

- 🏠 **Room System** — Create/join rooms with a 6-character code
- 🎧 **Server-Side Audio** — YouTube audio extracted & streamed via backend proxy (no iframe)
- 🔄 **Real-Time Sync** — Play, pause, seek synced across all listeners via Socket.IO
- 📊 **Sync Status** — Live offset display with auto-correction (< 500ms tolerance)
- 🎨 **Reactions** — Send floating emoji reactions to the room
- 📱 **Mobile Friendly** — Responsive dark theme with glass-morphism UI
- 🔁 **Host Controls** — Only the host controls playback; guests follow in sync

## 🚀 Quick Start

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/synctune.git
cd synctune

# Install dependencies
npm install

# Start the server
npm start
```

Open **http://localhost:3000** in your browser.

## 🏗️ Architecture

```
Client (Browser)                    Server (Node.js)
┌─────────────────┐               ┌──────────────────────┐
│  HTML5 <audio>   │◄──── GET ────│  /api/stream/:videoId │
│                  │   audio data  │  (ytdl-core proxy)   │
│  Socket.IO       │◄──── WS ────│  Socket.IO Server     │
│  (sync events)   │  play/pause  │  (room management)    │
└─────────────────┘               └──────────────────────┘
```

**How audio works:**
1. Host pastes a YouTube URL
2. Server extracts audio using `@distube/ytdl-core`
3. Audio streams through Express proxy endpoint with Range request support
4. Client plays via standard `<audio>` element — works on all browsers

## 📁 Project Structure

```
synctune/
├── package.json
├── .gitignore
├── server/
│   └── index.js           # Express + Socket.IO + audio proxy
└── public/
    ├── index.html          # Home — create/join rooms
    ├── room.html           # Player — synced listening
    ├── css/
    │   └── style.css       # Dark theme, glass-morphism
    └── js/
        ├── home.js         # Room code generation
        └── room.js         # Audio player, sync, reactions
```

## 🔧 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express |
| Real-time | Socket.IO |
| Audio | @distube/ytdl-core |
| Frontend | Vanilla HTML/CSS/JS |
| Design | Dark theme, Glass-morphism |

## 📝 License

MIT
