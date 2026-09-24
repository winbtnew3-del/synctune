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
// Room Management
// =============================================
const rooms = new Map();
const infoCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 min

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

  // Plain 11-character video ID
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

// Fetch video info via YouTube's official oEmbed API (100% reliable, never blocked)
function fetchOEmbedInfo(videoId) {
  return new Promise((resolve) => {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    
    const req = https.get(oembedUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            return resolve({
              videoId,
              title: parsed.title || 'YouTube Track',
              artist: parsed.author_name || 'YouTube',
              thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              duration: 0
            });
          } catch (e) {
            // fallback below
          }
        }
        // Fallback for unlisted/private or special videos
        resolve({
          videoId,
          title: `Track (${videoId})`,
          artist: 'YouTube Audio',
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          duration: 0
        });
      });
    });

    req.on('error', () => {
      resolve({
        videoId,
        title: `Track (${videoId})`,
        artist: 'YouTube Audio',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        duration: 0
      });
    });

    req.setTimeout(4000, () => {
      req.destroy();
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

async function getCachedInfo(videoId) {
  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const data = await fetchOEmbedInfo(videoId);
  infoCache.set(videoId, { data, ts: Date.now() });
  return data;
}

// =============================================
// REST API
// =============================================

// Video info endpoint
app.get('/api/info/:videoId', async (req, res) => {
  try {
    const videoId = extractVideoId(req.params.videoId);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid video ID or URL.' });
    }
    const data = await getCachedInfo(videoId);
    res.json(data);
  } catch (err) {
    console.error('[API] Info error:', err.message);
    res.json({
      videoId: req.params.videoId,
      title: 'YouTube Track',
      artist: 'YouTube Audio',
      thumbnail: `https://i.ytimg.com/vi/${req.params.videoId}/hqdefault.jpg`,
      duration: 0
    });
  }
});

// Parse YouTube URL endpoint
app.post('/api/parse-url', (req, res) => {
  const videoId = extractVideoId(req.body.url || '');
  if (videoId) {
    res.json({ videoId });
  } else {
    res.status(400).json({ error: 'Invalid YouTube link. Please check the URL.' });
  }
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
  console.log(`[+] Connected: ${socket.id}`);

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
        console.log(`[Room] Host reclaimed: ${code}`);
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

    console.log(`[Room] Created: ${code}`);
    callback({ success: true, code, role: 'host' });
  });

  // ---------- Join Room ----------
  socket.on('join-room', (data, callback) => {
    const code = (data?.code || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      return callback({ success: false, error: 'Room not found. Check the code and try again.' });
    }
    if (room.members.size >= 20) {
      return callback({ success: false, error: 'Room is full (max 20 listeners).' });
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
    console.log(`[Room] Guest joined ${code} (${room.members.size} members)`);

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

  // ---------- Track Change (host only) ----------
  socket.on('change-track', (trackData) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;

    room.currentTrack = trackData;
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    socket.to(socket.roomCode).emit('track-changed', {
      track: trackData,
      currentTime: 0,
      isPlaying: true
    });
    console.log(`[Track] ${trackData.title} in ${socket.roomCode}`);
  });

  // ---------- Play / Pause (host only) ----------
  socket.on('play-pause', ({ isPlaying, currentTime }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;

    room.isPlaying = isPlaying;
    room.currentTime = currentTime;
    room.lastUpdate = Date.now();

    socket.to(socket.roomCode).emit('sync-playback', {
      isPlaying,
      currentTime,
      serverTime: Date.now()
    });
  });

  // ---------- Seek (host only) ----------
  socket.on('seek', ({ currentTime }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;

    room.currentTime = currentTime;
    room.lastUpdate = Date.now();

    socket.to(socket.roomCode).emit('sync-seek', {
      currentTime,
      isPlaying: room.isPlaying,
      serverTime: Date.now()
    });
  });

  // ---------- Sync Request (guest heartbeat) ----------
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
    const member = room.members.get(socket.id);
    io.to(socket.roomCode).emit('reaction', {
      emoji,
      from: member?.role || 'guest',
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
        console.log(`[Room] Closed: ${socket.roomCode} (host timeout)`);
      }, 20000);
      console.log(`[Room] Host disconnected from ${socket.roomCode}, 20s grace period`);
    } else {
      io.to(socket.roomCode).emit('member-update', { memberCount: room.members.size });
    }
  });
});

// Periodic stale rooms cleanup
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
