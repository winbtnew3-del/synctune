// =============================================
// SyncTune — Room Logic
// =============================================

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || '').toUpperCase();
const role = params.get('role') || 'guest';

if (!roomCode) {
  window.location.href = '/';
}

const socket = io();
const audio = document.getElementById('audio-player');

const isHost = role === 'host';
let currentTrack = null;
let isLooping = false;
let syncInterval = null;

// =============================================
// Initialization
// =============================================

document.getElementById('header-room-code').textContent = roomCode;

// Role badge
if (isHost) {
  document.getElementById('role-icon').textContent = '👑';
  document.getElementById('role-label').textContent = 'Host';
  document.getElementById('role-badge').classList.add('host');
  document.getElementById('track-input').classList.remove('hidden');
  document.getElementById('empty-title').textContent = 'Paste a YouTube URL above';
  document.getElementById('empty-subtitle').textContent = 'Your guest will hear the same audio in sync';
} else {
  document.getElementById('role-icon').textContent = '🎧';
  document.getElementById('role-label').textContent = 'Guest';
  document.getElementById('role-badge').classList.add('guest');
}

// =============================================
// Socket.IO Connection
// =============================================

socket.on('connect', () => {
  console.log('[SyncTune] Connected:', socket.id);

  if (isHost) {
    socket.emit('create-room', { code: roomCode }, (res) => {
      if (res.success) {
        onRoomJoined(res);
      } else {
        showToast(res.error || 'Failed to create room', 'error');
        setTimeout(() => window.location.href = '/', 2000);
      }
    });
  } else {
    joinAsGuest();
  }
});

function joinAsGuest(retries = 0) {
  socket.emit('join-room', { code: roomCode }, (res) => {
    if (res.success) {
      onRoomJoined(res);
    } else if (retries < 10) {
      updateSyncStatus('Waiting for host…', 'waiting');
      setTimeout(() => joinAsGuest(retries + 1), 2000);
    } else {
      showToast('Room not found. Please check the code.', 'error');
      setTimeout(() => window.location.href = '/', 2000);
    }
  });
}

function onRoomJoined(res) {
  console.log('[SyncTune] Joined room:', res.code, 'as', res.role);
  updateSyncStatus(isHost ? 'Room ready — waiting for guests' : 'Connected as Guest', 'synced');

  if (res.state?.memberCount) {
    document.getElementById('member-count').textContent = res.state.memberCount;
  }

  // Guest: load current track if any
  if (!isHost && res.state?.currentTrack) {
    loadTrack(res.state.currentTrack, res.state.currentTime || 0, res.state.isPlaying || false);
  }

  // Guest: start periodic sync
  if (!isHost) {
    startSyncLoop();
  }
}

// =============================================
// Track Loading (Host)
// =============================================

const loadBtn = document.getElementById('load-track-btn');
const urlInput = document.getElementById('youtube-url');

if (loadBtn) loadBtn.addEventListener('click', handleLoadTrack);
if (urlInput) urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleLoadTrack();
});

async function handleLoadTrack() {
  const url = urlInput.value.trim();
  if (!url) return;

  const videoId = extractVideoId(url);
  if (!videoId) {
    showToast('Invalid YouTube URL. Please check and try again.', 'error');
    return;
  }

  loadBtn.disabled = true;
  loadBtn.textContent = '⏳ Loading...';

  try {
    const res = await fetch(`/api/info/${videoId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch');
    }

    const info = await res.json();
    const trackData = {
      videoId: info.videoId,
      title: info.title,
      artist: info.artist,
      duration: info.duration,
      thumbnail: info.thumbnail
    };

    setTrack(trackData);
    socket.emit('change-track', trackData);
    showToast(`🎵 Now playing: ${trackData.title}`);
  } catch (err) {
    console.error('[Load]', err);
    showToast('Failed to load track. Try another URL.', 'error');
  } finally {
    loadBtn.disabled = false;
    loadBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="2" width="20" height="20" rx="2"/>
        <polygon points="10,8 16,12 10,16" fill="currentColor"/>
      </svg>
      Change Track`;
  }
}

// =============================================
// Audio Player
// =============================================

function setTrack(trackData) {
  currentTrack = trackData;

  // Update UI
  document.getElementById('track-title').textContent = trackData.title;
  document.getElementById('track-artist').textContent = trackData.artist;
  document.getElementById('track-thumbnail').src = trackData.thumbnail;
  document.getElementById('mini-title').textContent = trackData.title;
  document.getElementById('total-time').textContent = formatTime(trackData.duration);
  document.getElementById('mini-time').textContent = `0:00 / ${formatTime(trackData.duration)}`;

  // Show player sections
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
  document.getElementById('player-controls').classList.remove('hidden');

  // Load audio from the server proxy
  audio.src = `/api/stream/${trackData.videoId}`;
  audio.load();

  // Reset progress
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-thumb').style.left = '0%';
  document.getElementById('current-time').textContent = '0:00';

  updatePlayButton(false);
}

function loadTrack(trackData, startTime = 0, autoPlay = false) {
  setTrack(trackData);

  const onCanPlay = () => {
    audio.removeEventListener('canplay', onCanPlay);
    if (startTime > 0 && startTime < (trackData.duration || Infinity)) {
      audio.currentTime = startTime;
    }
    if (autoPlay) {
      audio.play().then(() => {
        updatePlayButton(true);
      }).catch(() => {
        updateSyncStatus('Tap play to start listening', 'waiting');
      });
    }
  };
  audio.addEventListener('canplay', onCanPlay);
}

// ---- Play / Pause ----
document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);

function togglePlayPause() {
  if (!currentTrack) return;

  if (audio.paused) {
    audio.play().then(() => {
      updatePlayButton(true);
      if (isHost) {
        socket.emit('play-pause', { isPlaying: true, currentTime: audio.currentTime });
      }
    }).catch((err) => {
      console.error('[Play]', err);
      showToast('Playback failed. Try again.', 'error');
    });
  } else {
    audio.pause();
    updatePlayButton(false);
    if (isHost) {
      socket.emit('play-pause', { isPlaying: false, currentTime: audio.currentTime });
    }
  }
}

// ---- Skip Back ----
document.getElementById('skip-back-btn').addEventListener('click', () => {
  if (!currentTrack) return;
  audio.currentTime = 0;
  updateProgress();
  if (isHost) {
    socket.emit('seek', { currentTime: 0 });
  }
});

// ---- Loop ----
document.getElementById('loop-btn').addEventListener('click', () => {
  isLooping = !isLooping;
  audio.loop = isLooping;
  document.getElementById('loop-btn').classList.toggle('active', isLooping);
});

// ---- Volume ----
document.getElementById('volume-btn').addEventListener('click', () => {
  audio.muted = !audio.muted;
  document.getElementById('vol-on').classList.toggle('hidden', audio.muted);
  document.getElementById('vol-off').classList.toggle('hidden', !audio.muted);
});

// ---- Progress Bar ----
const progressBar = document.getElementById('progress-bar');

progressBar.addEventListener('click', (e) => {
  if (!currentTrack) return;
  seekToPosition(e.clientX);
});

// Touch drag for mobile
let dragging = false;
progressBar.addEventListener('mousedown', () => { dragging = true; });
progressBar.addEventListener('touchstart', (e) => { dragging = true; seekToPosition(e.touches[0].clientX); }, { passive: true });
document.addEventListener('mousemove', (e) => { if (dragging) seekToPosition(e.clientX); });
document.addEventListener('touchmove', (e) => { if (dragging) seekToPosition(e.touches[0].clientX); }, { passive: true });
document.addEventListener('mouseup', endDrag);
document.addEventListener('touchend', endDrag);

function seekToPosition(clientX) {
  if (!currentTrack) return;
  const rect = progressBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const time = pct * currentTrack.duration;
  audio.currentTime = time;
  updateProgress();
}

function endDrag() {
  if (dragging && currentTrack && isHost) {
    socket.emit('seek', { currentTime: audio.currentTime });
  }
  dragging = false;
}

// ---- Audio Events ----
audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('play', () => updatePlayButton(true));
audio.addEventListener('pause', () => updatePlayButton(false));
audio.addEventListener('ended', () => {
  if (!isLooping) {
    updatePlayButton(false);
    if (isHost) {
      socket.emit('play-pause', { isPlaying: false, currentTime: audio.duration || 0 });
    }
  }
});
audio.addEventListener('error', (e) => {
  console.error('[Audio] Error:', e);
  showToast('Audio playback error. Try reloading the track.', 'error');
});

function updateProgress() {
  if (!currentTrack || dragging) return;
  const dur = currentTrack.duration || audio.duration || 1;
  const pct = (audio.currentTime / dur) * 100;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-thumb').style.left = pct + '%';
  document.getElementById('current-time').textContent = formatTime(audio.currentTime);
  document.getElementById('mini-time').textContent = `${formatTime(audio.currentTime)} / ${formatTime(dur)}`;
}

function updatePlayButton(playing) {
  document.getElementById('play-icon').classList.toggle('hidden', playing);
  document.getElementById('pause-icon').classList.toggle('hidden', !playing);
  document.getElementById('mini-play-icon').textContent = playing ? '⏸' : '▶';

  // Waveform animation
  document.querySelectorAll('#waveform span').forEach(bar => {
    bar.style.animationPlayState = playing ? 'running' : 'paused';
  });
}

// =============================================
// Sync Events (Guest receives)
// =============================================

socket.on('track-changed', ({ track, currentTime, isPlaying }) => {
  loadTrack(track, currentTime, isPlaying);
  showToast(`🎵 Now playing: ${track.title}`);
});

socket.on('sync-playback', ({ isPlaying, currentTime, serverTime }) => {
  if (isHost) return;

  const latency = Math.max(0, (Date.now() - serverTime) / 1000);
  const adjustedTime = isPlaying ? currentTime + latency : currentTime;

  if (Math.abs(audio.currentTime - adjustedTime) > 0.3) {
    audio.currentTime = adjustedTime;
  }

  if (isPlaying && audio.paused) {
    audio.play().catch(() => {});
  } else if (!isPlaying && !audio.paused) {
    audio.pause();
  }
  updatePlayButton(isPlaying);
});

socket.on('sync-seek', ({ currentTime, isPlaying, serverTime }) => {
  if (isHost) return;

  const latency = Math.max(0, (Date.now() - serverTime) / 1000);
  audio.currentTime = isPlaying ? currentTime + latency : currentTime;
  updateProgress();
});

socket.on('member-update', ({ memberCount }) => {
  document.getElementById('member-count').textContent = memberCount;
  if (isHost && memberCount > 1) {
    updateSyncStatus(`${memberCount} listeners in sync`, 'synced');
  }
});

socket.on('room-closed', ({ reason }) => {
  showToast(reason || 'Room closed', 'error');
  setTimeout(() => window.location.href = '/', 2000);
});

// ---- Periodic Sync (Guest) ----
function startSyncLoop() {
  if (isHost || syncInterval) return;

  syncInterval = setInterval(() => {
    if (!currentTrack) return;

    socket.emit('sync-request', (state) => {
      if (!state) return;

      const latency = Math.max(0, (Date.now() - state.serverTime) / 1000);
      const serverPos = state.isPlaying ? state.currentTime + latency : state.currentTime;
      const offset = Math.abs(audio.currentTime - serverPos);

      // Correct if offset > 0.5s
      if (offset > 0.5) {
        audio.currentTime = serverPos;
      }

      // Sync play/pause state
      if (state.isPlaying && audio.paused) {
        audio.play().catch(() => {});
        updatePlayButton(true);
      } else if (!state.isPlaying && !audio.paused) {
        audio.pause();
        updatePlayButton(false);
      }

      // Update sync display
      if (offset < 0.05) {
        updateSyncStatus('Perfectly synchronized', 'synced');
      } else if (offset < 0.5) {
        updateSyncStatus(`In Sync • ${Math.round(offset * 1000)}ms offset`, 'synced');
      } else {
        updateSyncStatus(`Syncing… ${Math.round(offset * 1000)}ms offset`, 'syncing');
      }
    });
  }, 3000);
}

// =============================================
// Reactions
// =============================================

document.querySelectorAll('.reaction-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const emoji = btn.dataset.emoji;
    socket.emit('reaction', emoji);
    spawnFloatingEmoji(emoji);
    // Button pop animation
    btn.style.transform = 'scale(1.3)';
    setTimeout(() => btn.style.transform = '', 200);
  });
});

socket.on('reaction', ({ emoji }) => {
  spawnFloatingEmoji(emoji);
});

function spawnFloatingEmoji(emoji) {
  const container = document.getElementById('floating-reactions');
  const el = document.createElement('div');
  el.className = 'float-emoji';
  el.textContent = emoji;
  el.style.left = (10 + Math.random() * 80) + '%';
  el.style.animationDuration = (1.5 + Math.random() * 1) + 's';
  container.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// =============================================
// Copy Room Code
// =============================================

document.getElementById('copy-room-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    showToast('📋 Room code copied!');
  }).catch(() => {
    showToast('📋 Room code: ' + roomCode);
  });
});

// =============================================
// Reconnection
// =============================================

socket.on('disconnect', () => {
  updateSyncStatus('Reconnecting…', 'syncing');
});

socket.on('reconnect', () => {
  if (isHost) {
    socket.emit('create-room', { code: roomCode }, (res) => {
      if (res.success) updateSyncStatus('Reconnected', 'synced');
    });
  } else {
    joinAsGuest();
  }
});

// =============================================
// Utilities
// =============================================

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function extractVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function updateSyncStatus(text, status) {
  document.getElementById('sync-text').textContent = text;
  const dot = document.getElementById('sync-dot-footer');
  dot.className = 'sync-dot-footer ' + status;

  const badge = document.getElementById('sync-badge');
  if (badge) {
    const dotMini = badge.querySelector('.sync-dot-mini');
    if (status === 'synced') {
      badge.style.borderColor = 'rgba(6, 182, 212, 0.4)';
      if (dotMini) dotMini.style.background = '#10b981';
    } else if (status === 'syncing') {
      badge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
      if (dotMini) dotMini.style.background = '#f59e0b';
    }
  }
}

function showToast(message, type = 'success') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.className = 'toast hidden';
  }, 3500);
}

// ---- Mobile autoplay unlock ----
document.addEventListener('click', function unlock() {
  if (audio.paused && currentTrack && !isHost) {
    // Try to unlock audio context
    audio.play().then(() => {
      audio.pause();
      audio.currentTime = 0;
    }).catch(() => {});
  }
  document.removeEventListener('click', unlock);
}, { once: true });
