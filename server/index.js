const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const ytdl = require('@distube/ytdl-core');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function getCachedInfo(videoId) {
  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const raw = await ytdl.getInfo(videoId);
  const data = {
    videoId: raw.videoDetails.videoId,
    title: raw.videoDetails.title,
    artist: raw.videoDetails.author.name,
    duration: parseInt(raw.videoDetails.lengthSeconds),
    thumbnail: raw.videoDetails.thumbnails.sort((a, b) => b.width - a.width)[0]?.url || '',
    formats: raw.formats
  };
  infoCache.set(videoId, { data, ts: Date.now() });
  return data;
}

// =============================================
// REST API
// =============================================

// Video info endpoint
app.get('/api/info/:videoId', async (req, res) => {
  try {
    const data = await getCachedInfo(req.params.videoId);
    res.json({
      videoId: data.videoId,
      title: data.title,
      artist: data.artist,
      duration: data.duration,
      thumbnail: data.thumbnail
    });
  } catch (err) {
    console.error('[API] Info error:', err.message);
    res.status(400).json({ error: 'Could not fetch video info. Check the video ID.' });
  }
});

// Audio stream proxy — the "audio server"
app.get('/api/stream/:videoId', async (req, res) => {
  try {
    const raw = await ytdl.getInfo(req.params.videoId);
    const format = ytdl.chooseFormat(raw.formats, {
      quality: 'highestaudio',
      filter: 'audioonly'
    });

    if (!format) {
      return res.status(400).json({ error: 'No audio format found' });
    }

    const contentType = format.mimeType ? format.mimeType.split(';')[0] : 'audio/webm';
    const contentLength = parseInt(format.contentLength) || 0;
    const rangeHeader = req.headers.range;

    // Range request support for seeking
    if (rangeHeader && contentLength) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0]);
      const end = parts[1] ? parseInt(parts[1]) : contentLength - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${contentLength}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', contentType);

      const stream = ytdl.downloadFromInfo(raw, { format, range: { start, end } });
      stream.on('error', (e) => {
        console.error('[Stream] Range error:', e.message);
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
      req.on('close', () => stream.destroy());
    } else {
      // Full stream
      res.setHeader('Content-Type', contentType);
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
        res.setHeader('Accept-Ranges', 'bytes');
      }

      const stream = ytdl.downloadFromInfo(raw, { format });
      stream.on('error', (e) => {
        console.error('[Stream] Error:', e.message);
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
      req.on('close', () => stream.destroy());
    }
  } catch (err) {
    console.error('[API] Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not stream audio' });
    }
  }
});

// Parse YouTube URL
app.post('/api/parse-url', (req, res) => {
  const videoId = extractVideoId(req.body.url || '');
  if (videoId) {
    res.json({ videoId });
  } else {
    res.status(400).json({ error: 'Invalid YouTube URL' });
  }
});

// Serve room page
app.get('/room', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'room.html'));
});

// =============================================
// Socket.IO — Real-time sync
// =============================================
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ---------- Create Room ----------
  socket.on('create-room', (data, callback) => {
    if (typeof data === 'function') { callback = data; data = {}; }

    const code = (data?.code || '').toUpperCase() || generateRoomCode();

    if (rooms.has(code)) {
      // If the room exists but host disconnected, allow reclaim
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
    if (room.members.size >= 10) {
      return callback({ success: false, error: 'Room is full (max 10).' });
    }

    room.members.set(socket.id, { role: 'guest', joinedAt: Date.now() });
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'guest';

    // Calculate current playback time
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
    room.isPlaying = false;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    socket.to(socket.roomCode).emit('track-changed', {
      track: trackData,
      currentTime: 0,
      isPlaying: false
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
    if (!room) return callback(null);

    let currentTime = room.currentTime;
    if (room.isPlaying) {
      currentTime += (Date.now() - room.lastUpdate) / 1000;
    }
    callback({
      currentTime,
      isPlaying: room.isPlaying,
      serverTime: Date.now()
    });
  });

  // ---------- Time Sync (latency measurement) ----------
  socket.on('time-sync', (callback) => {
    callback({ serverTime: Date.now() });
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
    console.log(`[-] Disconnected: ${socket.id}`);
    if (!socket.roomCode) return;

    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.members.delete(socket.id);

    if (socket.id === room.hostId) {
      // Grace period — host might be refreshing
      room.hostDisconnectTimer = setTimeout(() => {
        io.to(socket.roomCode).emit('room-closed', { reason: 'Host has left the room' });
        rooms.delete(socket.roomCode);
        console.log(`[Room] Closed: ${socket.roomCode} (host timeout)`);
      }, 15000);
      console.log(`[Room] Host disconnected from ${socket.roomCode}, 15s grace period`);
    } else {
      io.to(socket.roomCode).emit('member-update', { memberCount: room.members.size });
    }
  });
});

// Cleanup stale rooms every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.members.size === 0 || now - room.createdAt > 24 * 60 * 60 * 1000) {
      rooms.delete(code);
      console.log(`[Cleanup] Removed: ${code}`);
    }
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🎵 SyncTune server running at http://localhost:${PORT}\n`);
});
