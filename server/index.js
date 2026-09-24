const express = require('express');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Path to yt-dlp binary
const ytdlpBinary = process.platform === 'win32'
  ? path.join(__dirname, '..', 'yt-dlp.exe')
  : path.join(__dirname, '..', 'yt-dlp');

console.log('[SyncTune] Using yt-dlp binary at:', ytdlpBinary, fs.existsSync(ytdlpBinary) ? '(found)' : '(missing)');

// =============================================
// Room Management & State
// =============================================
const rooms = new Map();
const infoCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hr

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function extractVideoId(url) {
  if (!url) return null;
  const trimmed = url.trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  const patterns = [
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/
  ];

  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Fetch metadata: fast oEmbed + duration check
function fetchVideoInfo(videoId) {
  return new Promise((resolve) => {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    
    https.get(oembedUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let meta = {
          videoId,
          title: 'YouTube Track',
          artist: 'YouTube Music',
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          duration: 0
        };

        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            meta.title = parsed.title || meta.title;
            meta.artist = parsed.author_name || meta.artist;
          } catch (e) {}
        }

        // Try getting exact duration from yt-dlp in background (non-blocking fallback)
        if (fs.existsSync(ytdlpBinary)) {
          execFile(ytdlpBinary, ['--get-duration', `https://www.youtube.com/watch?v=${videoId}`], { timeout: 4000 }, (err, stdout) => {
            if (!err && stdout) {
              const parts = stdout.trim().split(':').map(Number);
              let durSec = 0;
              if (parts.length === 3) durSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
              else if (parts.length === 2) durSec = parts[0] * 60 + parts[1];
              else if (parts.length === 1) durSec = parts[0];
              if (durSec > 0) meta.duration = durSec;
            }
            resolve(meta);
          });
        } else {
          resolve(meta);
        }
      });
    }).on('error', () => {
      resolve({
        videoId,
        title: `Track (${videoId})`,
        artist: 'YouTube Audio',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        duration: 0
      });
    });
  });
}

// =============================================
// REST Endpoints
// =============================================

// Video info
app.get('/api/info/:videoId', async (req, res) => {
  const videoId = extractVideoId(req.params.videoId);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube link.' });
  }

  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const data = await fetchVideoInfo(videoId);
    infoCache.set(videoId, { data, ts: Date.now() });
    res.json(data);
  } catch (err) {
    res.json({
      videoId,
      title: 'YouTube Track',
      artist: 'YouTube Music',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: 0
    });
  }
});

// Dedicated Audio Streaming Server Proxy:
// Pipes pure audio directly to the HTML5 audio element
app.get('/api/stream/:videoId', (req, res) => {
  const videoId = extractVideoId(req.params.videoId);
  if (!videoId) {
    return res.status(400).send('Invalid video ID');
  }

  if (!fs.existsSync(ytdlpBinary)) {
    console.error('[Stream] yt-dlp binary missing at:', ytdlpBinary);
    return res.status(500).send('Audio streaming binary unavailable');
  }

  console.log(`[Stream] Starting audio stream for: ${videoId}`);

  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Cache-Control', 'no-cache');

  // Spawn yt-dlp to stream audio/mp4 directly to stdout
  const ytdlp = spawn(ytdlpBinary, [
    '-o', '-',
    '-f', 'ba[ext=m4a]/ba',
    '--no-warnings',
    '--no-playlist',
    `https://www.youtube.com/watch?v=${videoId}`
  ]);

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on('data', (d) => {
    // console.log(`[yt-dlp stderr] ${d.toString()}`);
  });

  ytdlp.on('error', (err) => {
    console.error('[Stream] Spawn error:', err.message);
    if (!res.headersSent) res.status(500).end();
  });

  // Kill child process if user closes tab/disconnects
  req.on('close', () => {
    try {
      ytdlp.kill('SIGKILL');
    } catch (e) {}
  });
});

// Serve room page
app.get('/room', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'room.html'));
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// =============================================
// Socket.IO — Real-time Room Sync
// =============================================
io.on('connection', (socket) => {
  // ---------- Create Room ----------
  socket.on('create-room', (data, callback) => {
    if (typeof data === 'function') { callback = data; data = {}; }
    const code = (data?.code || '').toUpperCase() || generateRoomCode();

    if (rooms.has(code)) {
      const existing = rooms.get(code);
      if (existing.hostDisconnectTimer) {
        clearTimeout(existing.hostDisconnectTimer);
        existing.hostDisconnectTimer = null;
        existing.hostId = socket.id;
        existing.members.set(socket.id, { role: 'host', joinedAt: Date.now() });
        socket.join(code);
        socket.roomCode = code;
        socket.role = 'host';

        io.to(code).emit('member-update', { memberCount: existing.members.size });
        return callback({ success: true, code, role: 'host' });
      }
      return callback({ success: false, error: 'Room code already in use' });
    }

    const room = {
      code,
      hostId: socket.id,
      members: new Map([[socket.id, { role: 'host', joinedAt: Date.now() }]]),
      currentTrack: null,
      isPlaying: false,
      currentTime: 0,
      lastUpdate: Date.now(),
      createdAt: Date.now(),
      hostDisconnectTimer: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'host';

    callback({ success: true, code, role: 'host' });
  });

  // ---------- Join Room ----------
  socket.on('join-room', (data, callback) => {
    const code = (data?.code || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      return callback({ success: false, error: 'Room not found. Check the code.' });
    }
    if (room.members.size >= 25) {
      return callback({ success: false, error: 'Room is full (max 25).' });
    }

    room.members.set(socket.id, { role: 'guest', joinedAt: Date.now() });
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'guest';

    let currentTime = room.currentTime;
    if (room.isPlaying) {
      currentTime += (Date.now() - room.lastUpdate) / 1000;
    }

    io.to(code).emit('member-update', { memberCount: room.members.size });

    callback({
      success: true,
      code,
      role: 'guest',
      state: {
        currentTrack: room.currentTrack,
        isPlaying: room.isPlaying,
        currentTime,
        memberCount: room.members.size
      }
    });
  });

  // ---------- Track Change ----------
  socket.on('change-track', (trackData) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.currentTrack = trackData;
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    // Broadcast to EVERYONE in room (including other guests/hosts)
    socket.to(socket.roomCode).emit('track-changed', {
      track: trackData,
      currentTime: 0,
      isPlaying: true
    });
  });

  // ---------- Play / Pause (Synced for BOTH devices) ----------
  socket.on('play-pause', ({ isPlaying, currentTime }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.isPlaying = isPlaying;
    room.currentTime = currentTime;
    room.lastUpdate = Date.now();

    // Broadcast to ALL OTHER listeners so both phone & computer pause/play together!
    socket.to(socket.roomCode).emit('sync-playback', {
      isPlaying,
      currentTime,
      serverTime: Date.now()
    });
  });

  // ---------- Seek (Synced for BOTH devices) ----------
  socket.on('seek', ({ currentTime }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.currentTime = currentTime;
    room.lastUpdate = Date.now();

    socket.to(socket.roomCode).emit('sync-seek', {
      currentTime,
      isPlaying: room.isPlaying,
      serverTime: Date.now()
    });
  });

  // ---------- Heartbeat Sync Request ----------
  socket.on('sync-request', (callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback && callback(null);

    let currentTime = room.currentTime;
    if (room.isPlaying) {
      currentTime += (Date.now() - room.lastUpdate) / 1000;
    }
    if (callback) {
      callback({
        currentTime,
        isPlaying: room.isPlaying,
        serverTime: Date.now()
      });
    }
  });

  // ---------- Reactions ----------
  socket.on('reaction', (emoji) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    io.to(socket.roomCode).emit('reaction', {
      emoji,
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
    });
  });

  // ---------- Disconnect ----------
  socket.on('disconnect', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.members.delete(socket.id);

    if (socket.id === room.hostId) {
      room.hostDisconnectTimer = setTimeout(() => {
        io.to(socket.roomCode).emit('room-closed', { reason: 'Host has left the room.' });
        rooms.delete(socket.roomCode);
      }, 30000); // 30s grace period for refresh/network blip
    } else {
      io.to(socket.roomCode).emit('member-update', { memberCount: room.members.size });
    }
  });
});

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.members.size === 0 || now - room.createdAt > 24 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🎵 SyncTune server running at http://localhost:${PORT}\n`);
});
