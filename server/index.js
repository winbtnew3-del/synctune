const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');

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

// =============================================
// Room Management & State
// =============================================
const rooms = new Map();
const infoCache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hrs

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

// Fetch metadata via YouTube's official oEmbed API
function fetchOEmbed(videoId) {
  return new Promise((resolve) => {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    https.get(oembedUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            return resolve({
              videoId,
              title: parsed.title || 'YouTube Track',
              artist: parsed.author_name || 'YouTube Music',
              thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            });
          } catch (e) {}
        }
        resolve({
          videoId,
          title: `Track (${videoId})`,
          artist: 'YouTube Music',
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        });
      });
    }).on('error', () => {
      resolve({
        videoId,
        title: `Track (${videoId})`,
        artist: 'YouTube Music',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      });
    });
  });
}

// =============================================
// REST Endpoints
// =============================================

// Video Info
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
    const data = await fetchOEmbed(videoId);
    infoCache.set(videoId, { data, ts: Date.now() });
    res.json(data);
  } catch (err) {
    res.json({
      videoId,
      title: 'YouTube Track',
      artist: 'YouTube Music',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    });
  }
});

// Room page
app.get('/room', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'room.html'));
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// =============================================
// Socket.IO — Real-time Room Sync (Two-Way)
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
    if (room.members.size >= 30) {
      return callback({ success: false, error: 'Room is full (max 30).' });
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

    // Broadcast track change to all other listeners
    socket.to(socket.roomCode).emit('track-changed', {
      track: trackData,
      currentTime: 0,
      isPlaying: true
    });
  });

  // ---------- Play / Pause (Two-way sync: PC <-> Mobile) ----------
  socket.on('play-pause', ({ isPlaying, currentTime }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.isPlaying = isPlaying;
    room.currentTime = currentTime;
    room.lastUpdate = Date.now();

    // Broadcast to ALL OTHER listeners so both phone & computer pause/play simultaneously!
    socket.to(socket.roomCode).emit('sync-playback', {
      isPlaying,
      currentTime,
      serverTime: Date.now()
    });
  });

  // ---------- Seek (Two-way sync: PC <-> Mobile) ----------
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

  // ---------- Heartbeat Sync ----------
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
      }, 30000);
    } else {
      io.to(socket.roomCode).emit('member-update', { memberCount: room.members.size });
    }
  });
});

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
