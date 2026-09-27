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
const CACHE_TTL = 2 * 60 * 60 * 1000;

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
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
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

// Helper: get member list with names (deduplicated by name)
function getMemberList(room) {
  const list = [];
  const seen = new Set();

  // Host first if present
  if (room.hostId && room.members.has(room.hostId)) {
    const host = room.members.get(room.hostId);
    const hostName = (host.name || 'Host').trim();
    seen.add(hostName.toLowerCase());
    list.push({ id: room.hostId, name: hostName, role: 'host' });
  }

  for (const [sid, m] of room.members) {
    if (sid === room.hostId) continue;
    const name = (m.name || 'Anonymous').trim();
    const nameKey = name.toLowerCase();
    if (!seen.has(nameKey)) {
      seen.add(nameKey);
      list.push({ id: sid, name, role: m.role || 'guest' });
    }
  }
  return list;
}

// =============================================
// REST Endpoints
// =============================================

app.get('/api/info/:videoId', async (req, res) => {
  const videoId = extractVideoId(req.params.videoId);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube link.' });

  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return res.json(cached.data);

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

app.get('/room', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'room.html'));
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// =============================================
// Socket.IO — Real-time Room Sync
// =============================================
io.on('connection', (socket) => {
  // ---------- NTP Clock Ping ----------
  socket.on('sync-ping', (clientT0, callback) => {
    if (typeof callback === 'function') {
      callback({ clientT0, serverT1: Date.now() });
    }
  });

  // ---------- Create Room ----------
  socket.on('create-room', (data, callback) => {
    if (typeof data === 'function') { callback = data; data = {}; }
    const code = (data?.code || '').toUpperCase() || generateRoomCode();
    const userName = (data?.name || 'Host').substring(0, 20);

    if (rooms.has(code)) {
      const existing = rooms.get(code);
      if (existing.hostDisconnectTimer) {
        clearTimeout(existing.hostDisconnectTimer);
        existing.hostDisconnectTimer = null;
      }
      existing.hostId = socket.id;

      // Clean up any stale sockets with the same name to avoid duplicates
      const cleanName = userName.trim().toLowerCase();
      for (const [sid, m] of existing.members) {
        if (m.name && m.name.trim().toLowerCase() === cleanName && sid !== socket.id) {
          existing.members.delete(sid);
        }
      }

      existing.members.set(socket.id, { role: 'host', name: userName, joinedAt: Date.now() });
      socket.join(code);
      socket.roomCode = code;
      socket.role = 'host';
      socket.userName = userName;

      let currentTime = existing.currentTime;
      if (existing.isPlaying) {
        currentTime += Math.max(0, (Date.now() - existing.lastUpdate) / 1000);
      }

      io.to(code).emit('member-update', {
        memberCount: existing.members.size,
        members: getMemberList(existing)
      });
      return callback({
        success: true,
        code,
        role: 'host',
        state: {
          currentTrack: existing.currentTrack,
          isPlaying: existing.isPlaying,
          currentTime,
          serverTime: Date.now(),
          memberCount: existing.members.size,
          members: getMemberList(existing),
          queue: existing.queue,
          queueIndex: existing.queueIndex
        }
      });
    }

    const room = {
      code,
      hostId: socket.id,
      members: new Map([[socket.id, { role: 'host', name: userName, joinedAt: Date.now() }]]),
      queue: [],          // Spotify-like queue
      queueIndex: -1,     // Currently playing index
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
    socket.userName = userName;

    callback({
      success: true,
      code,
      role: 'host',
      state: {
        currentTrack: room.currentTrack,
        isPlaying: room.isPlaying,
        currentTime: 0,
        serverTime: Date.now(),
        memberCount: room.members.size,
        members: getMemberList(room),
        queue: room.queue,
        queueIndex: room.queueIndex
      }
    });
  });

  // ---------- Join Room ----------
  socket.on('join-room', (data, callback) => {
    const code = (data?.code || '').toUpperCase().trim();
    const userName = (data?.name || 'Listener').substring(0, 20);
    const room = rooms.get(code);

    if (!room) return callback({ success: false, error: 'Room not found. Check the code.' });
    if (room.members.size >= 30) return callback({ success: false, error: 'Room is full (max 30).' });

    // Clean up any stale sockets with the same name to avoid duplicates
    const cleanName = userName.trim().toLowerCase();
    for (const [sid, m] of room.members) {
      if (m.name && m.name.trim().toLowerCase() === cleanName && sid !== socket.id) {
        room.members.delete(sid);
      }
    }

    room.members.set(socket.id, { role: 'guest', name: userName, joinedAt: Date.now() });
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'guest';
    socket.userName = userName;

    let currentTime = room.currentTime;
    if (room.isPlaying) {
      currentTime += Math.max(0, (Date.now() - room.lastUpdate) / 1000);
    }

    io.to(code).emit('member-update', {
      memberCount: room.members.size,
      members: getMemberList(room)
    });

    // Send notification to room that someone joined
    socket.to(code).emit('user-joined', { name: userName });

    callback({
      success: true,
      code,
      role: 'guest',
      state: {
        currentTrack: room.currentTrack,
        isPlaying: room.isPlaying,
        currentTime,
        serverTime: Date.now(),
        memberCount: room.members.size,
        members: getMemberList(room),
        queue: room.queue,
        queueIndex: room.queueIndex
      }
    });
  });

  // ---------- Add to Queue ----------
  socket.on('queue-add', (trackData, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const queueItem = {
      ...trackData,
      addedBy: socket.userName || 'Anonymous',
      addedAt: Date.now(),
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
    };

    room.queue.push(queueItem);

    // Broadcast updated queue to all
    io.to(socket.roomCode).emit('queue-updated', {
      queue: room.queue,
      queueIndex: room.queueIndex,
      addedBy: socket.userName,
      addedTrack: queueItem.title
    });

    // If nothing is playing, auto-play this track
    if (!room.currentTrack) {
      room.queueIndex = 0;
      room.currentTrack = queueItem;
      room.isPlaying = true;
      room.currentTime = 0;
      room.lastUpdate = Date.now();

      io.to(socket.roomCode).emit('track-changed', {
        track: queueItem,
        currentTime: 0,
        isPlaying: true,
        serverTime: Date.now(),
        changedBy: socket.userName,
        queueIndex: 0
      });
    }

    if (typeof callback === 'function') callback({ success: true, queueLength: room.queue.length });
  });

  // ---------- Remove from Queue ----------
  socket.on('queue-remove', (itemId) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const idx = room.queue.findIndex(q => q.id === itemId);
    if (idx === -1) return;

    // Don't remove currently playing track
    if (idx === room.queueIndex) return;

    room.queue.splice(idx, 1);
    if (idx < room.queueIndex) room.queueIndex--;

    io.to(socket.roomCode).emit('queue-updated', {
      queue: room.queue,
      queueIndex: room.queueIndex
    });
  });

  // ---------- Skip to Next Track ----------
  socket.on('queue-next', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.queue.length === 0) return;

    const nextIdx = room.queueIndex + 1;
    if (nextIdx >= room.queue.length) {
      // End of queue
      room.isPlaying = false;
      room.currentTime = 0;
      io.to(socket.roomCode).emit('queue-ended');
      return;
    }

    room.queueIndex = nextIdx;
    room.currentTrack = room.queue[nextIdx];
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    io.to(socket.roomCode).emit('track-changed', {
      track: room.queue[nextIdx],
      currentTime: 0,
      isPlaying: true,
      serverTime: Date.now(),
      changedBy: socket.userName || 'System',
      queueIndex: nextIdx
    });
  });

  // ---------- Skip to Previous Track ----------
  socket.on('queue-prev', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.queue.length === 0) return;

    const prevIdx = Math.max(0, room.queueIndex - 1);
    room.queueIndex = prevIdx;
    room.currentTrack = room.queue[prevIdx];
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    io.to(socket.roomCode).emit('track-changed', {
      track: room.queue[prevIdx],
      currentTime: 0,
      isPlaying: true,
      serverTime: Date.now(),
      changedBy: socket.userName || 'System',
      queueIndex: prevIdx
    });
  });

  // ---------- Play specific queue item ----------
  socket.on('queue-play', (itemId) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const idx = room.queue.findIndex(q => q.id === itemId);
    if (idx === -1) return;

    room.queueIndex = idx;
    room.currentTrack = room.queue[idx];
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    io.to(socket.roomCode).emit('track-changed', {
      track: room.queue[idx],
      currentTime: 0,
      isPlaying: true,
      serverTime: Date.now(),
      changedBy: socket.userName || 'Anonymous',
      queueIndex: idx
    });
  });

  // ---------- Track Change (legacy / direct) ----------
  socket.on('change-track', (trackData) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const now = Date.now();
    room.currentTrack = trackData;
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = now;

    socket.to(socket.roomCode).emit('track-changed', {
      track: trackData,
      currentTime: 0,
      isPlaying: true,
      serverTime: now,
      changedBy: socket.userName || 'Anonymous'
    });
  });

  // ---------- Host Real-Time Time Sync Broadcast ----------
  socket.on('host-time-sync', ({ currentTime }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const now = Date.now();
    room.currentTime = currentTime;
    room.lastUpdate = now;

    socket.to(socket.roomCode).emit('time-sync-update', {
      currentTime,
      serverTime: now
    });
  });

  // ---------- Play / Pause Synchronized ----------
  socket.on('play-pause', ({ isPlaying, currentTime, scheduledServerTime }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const now = Date.now();
    room.isPlaying = isPlaying;
    room.currentTime = currentTime;
    room.lastUpdate = now;

    socket.to(socket.roomCode).emit('sync-playback', {
      isPlaying,
      currentTime,
      scheduledServerTime: scheduledServerTime || now,
      serverTime: now
    });
  });

  // ---------- Seek Synchronized ----------
  socket.on('seek', ({ currentTime }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const now = Date.now();
    room.currentTime = currentTime;
    room.lastUpdate = now;

    socket.to(socket.roomCode).emit('sync-seek', {
      currentTime,
      isPlaying: room.isPlaying,
      serverTime: now
    });
  });

  // ---------- Track Ended (auto-next) ----------
  socket.on('track-ended', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.queue.length === 0) return;

    const nextIdx = room.queueIndex + 1;
    if (nextIdx >= room.queue.length) {
      room.isPlaying = false;
      io.to(socket.roomCode).emit('queue-ended');
      return;
    }

    room.queueIndex = nextIdx;
    room.currentTrack = room.queue[nextIdx];
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    io.to(socket.roomCode).emit('track-changed', {
      track: room.queue[nextIdx],
      currentTime: 0,
      isPlaying: true,
      serverTime: Date.now(),
      changedBy: 'Auto-Queue',
      queueIndex: nextIdx
    });
  });

  // ---------- Heartbeat Query ----------
  socket.on('sync-request', (callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback && callback(null);

    const now = Date.now();
    let currentTime = room.currentTime;
    if (room.isPlaying) {
      currentTime += Math.max(0, (now - room.lastUpdate) / 1000);
    }

    if (typeof callback === 'function') {
      callback({
        currentTime,
        isPlaying: room.isPlaying,
        serverTime: now
      });
    }
  });

  // ---------- Reactions ----------
  socket.on('reaction', (emoji) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    io.to(socket.roomCode).emit('reaction', {
      emoji,
      name: socket.userName || 'Someone',
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
    });
  });

  // ---------- Disconnect ----------
  socket.on('disconnect', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const userName = socket.userName || 'Someone';
    room.members.delete(socket.id);

    // Immediately update all remaining listeners in the room
    io.to(socket.roomCode).emit('member-update', {
      memberCount: room.members.size,
      members: getMemberList(room)
    });
    io.to(socket.roomCode).emit('user-left', { name: userName });

    if (socket.id === room.hostId) {
      // If there are other members in the room, promote next member to host so room stays alive!
      if (room.members.size > 0) {
        const [nextSid, nextM] = room.members.entries().next().value;
        room.hostId = nextSid;
        nextM.role = 'host';
        io.to(socket.roomCode).emit('member-update', {
          memberCount: room.members.size,
          members: getMemberList(room)
        });
        io.to(nextSid).emit('role-changed', { role: 'host' });
      } else {
        // Room is empty - keep alive for 2 hours in case members reconnect
        if (room.hostDisconnectTimer) clearTimeout(room.hostDisconnectTimer);
        room.hostDisconnectTimer = setTimeout(() => {
          if (room.members.size === 0) {
            rooms.delete(socket.roomCode);
          }
        }, 2 * 60 * 60 * 1000);
      }
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
