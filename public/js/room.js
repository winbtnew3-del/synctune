// =============================================
// SyncTune — Pure Audio & Real-Time Sync Logic
// =============================================

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || '').toUpperCase().trim();
const role = params.get('role') || 'guest';

if (!roomCode) {
  window.location.href = '/';
}

const socket = io();
const audio = document.getElementById('audio-player');
const isHost = role === 'host';

let currentTrack = null;
let isLooping = false;
let isSeeking = false;
let syncInterval = null;
let localDuration = 0;
let isAudioUnlocked = false;

// UI Initialization
document.getElementById('header-room-code').textContent = roomCode;

if (isHost) {
  document.getElementById('role-icon').textContent = '👑';
  document.getElementById('role-label').textContent = 'Host';
  document.getElementById('role-badge').classList.add('host');
  document.getElementById('empty-title').textContent = 'Paste a YouTube link above';
  document.getElementById('empty-subtitle').textContent = 'Pure high-quality audio will stream in perfect sync to all devices';
} else {
  document.getElementById('role-icon').textContent = '🎧';
  document.getElementById('role-label').textContent = 'Guest';
  document.getElementById('role-badge').classList.add('guest');
  document.getElementById('empty-title').textContent = 'Waiting for music to start...';
  document.getElementById('empty-subtitle').textContent = 'Audio will play automatically in sync when a track is started';
}

// =============================================
// Media Session API for Lock Screen Playback
// =============================================

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || 'SyncTune Track',
    artist: track.artist || 'YouTube Music',
    album: 'SyncTune Session',
    artwork: [
      { src: track.thumbnail, sizes: '96x96', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '128x128', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '192x192', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' }
    ]
  });

  // Lock screen controls
  navigator.mediaSession.setActionHandler('play', () => {
    handlePlayPauseAction(true);
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    handlePlayPauseAction(false);
  });
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime !== undefined) {
      audio.currentTime = details.seekTime;
      socket.emit('seek', { currentTime: details.seekTime });
    }
  });
}

// Unlock audio context on first mobile tap/click
function unlockAudio() {
  if (isAudioUnlocked) return;
  isAudioUnlocked = true;

  // Play and immediately pause to establish mobile background audio session
  audio.play().then(() => {
    if (!currentTrack || audio.paused) audio.pause();
  }).catch(() => {});

  hideMobileSyncPrompt();
}

window.addEventListener('click', unlockAudio, { once: true });
window.addEventListener('touchstart', unlockAudio, { once: true });

// =============================================
// Socket.IO Room Connection
// =============================================

socket.on('connect', () => {
  console.log('[SyncTune] Socket connected:', socket.id);

  if (isHost) {
    socket.emit('create-room', { code: roomCode }, (res) => {
      if (res && res.success) {
        onRoomJoined(res);
      } else {
        showToast(res?.error || 'Failed to create room', 'error');
        setTimeout(() => window.location.href = '/', 2500);
      }
    });
  } else {
    joinAsGuest();
  }
});

function joinAsGuest(retries = 0) {
  socket.emit('join-room', { code: roomCode }, (res) => {
    if (res && res.success) {
      onRoomJoined(res);
    } else if (retries < 10) {
      updateSyncStatus('Connecting to room…', 'waiting');
      setTimeout(() => joinAsGuest(retries + 1), 2000);
    } else {
      showToast(res?.error || 'Room not found.', 'error');
      setTimeout(() => window.location.href = '/', 2500);
    }
  });
}

function onRoomJoined(res) {
  console.log('[SyncTune] Joined room:', res.code);
  updateSyncStatus('Room ready — sync active', 'synced');

  if (res.state?.memberCount) {
    document.getElementById('member-count').textContent = res.state.memberCount;
  }

  // Load existing track
  if (res.state?.currentTrack) {
    loadTrack(res.state.currentTrack, res.state.currentTime || 0, res.state.isPlaying !== false);
  }

  startSyncHeartbeat();
}

// =============================================
// Track Loading
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
    showToast('Invalid YouTube link. Please check the URL.', 'error');
    return;
  }

  loadBtn.disabled = true;
  loadBtn.textContent = '⏳ Loading...';

  try {
    const res = await fetch(`/api/info/${videoId}`);
    const info = await res.json();

    const trackData = {
      videoId: info.videoId || videoId,
      title: info.title || 'YouTube Audio',
      artist: info.artist || 'YouTube Music',
      thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: info.duration || 0
    };

    setTrack(trackData);
    socket.emit('change-track', trackData);
    showToast(`🎵 Loaded: ${trackData.title}`);
  } catch (err) {
    console.error('[Load error]', err);
    const fallback = {
      videoId,
      title: 'YouTube Track',
      artist: 'YouTube Music',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: 0
    };
    setTrack(fallback);
    socket.emit('change-track', fallback);
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

function setTrack(trackData) {
  currentTrack = trackData;

  // Update UI Metadata
  document.getElementById('track-title').textContent = trackData.title;
  document.getElementById('track-artist').textContent = trackData.artist;
  document.getElementById('track-thumbnail').src = trackData.thumbnail;
  document.getElementById('mini-title').textContent = trackData.title;

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
  document.getElementById('player-controls').classList.remove('hidden');

  updateMediaSession(trackData);

  // Set pure audio stream source from backend proxy
  audio.src = `/api/stream/${trackData.videoId}`;
  audio.load();

  audio.play().then(() => {
    updatePlayButton(true);
    socket.emit('play-pause', { isPlaying: true, currentTime: 0 });
  }).catch(() => {
    showMobileSyncPrompt();
  });
}

function loadTrack(trackData, startTime = 0, autoPlay = true) {
  currentTrack = trackData;

  document.getElementById('track-title').textContent = trackData.title;
  document.getElementById('track-artist').textContent = trackData.artist;
  document.getElementById('track-thumbnail').src = trackData.thumbnail;
  document.getElementById('mini-title').textContent = trackData.title;

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
  document.getElementById('player-controls').classList.remove('hidden');

  updateMediaSession(trackData);

  audio.src = `/api/stream/${trackData.videoId}`;
  audio.load();

  const onCanPlay = () => {
    audio.removeEventListener('canplay', onCanPlay);
    if (startTime > 0) audio.currentTime = startTime;

    if (autoPlay) {
      audio.play().then(() => {
        updatePlayButton(true);
      }).catch(() => {
        showMobileSyncPrompt();
      });
    }
  };

  audio.addEventListener('canplay', onCanPlay);
}

// =============================================
// Synchronized Playback Controls (Computer & Mobile)
// =============================================

document.getElementById('play-pause-btn').addEventListener('click', () => {
  if (!currentTrack) return;
  const wantPlay = audio.paused;
  handlePlayPauseAction(wantPlay);
});

function handlePlayPauseAction(play) {
  if (play) {
    audio.play().then(() => {
      updatePlayButton(true);
      socket.emit('play-pause', { isPlaying: true, currentTime: audio.currentTime });
    }).catch(() => {
      showMobileSyncPrompt();
    });
  } else {
    audio.pause();
    updatePlayButton(false);
    socket.emit('play-pause', { isPlaying: false, currentTime: audio.currentTime });
  }
}

// Skip Back / Restart
document.getElementById('skip-back-btn').addEventListener('click', () => {
  if (!currentTrack) return;
  audio.currentTime = 0;
  socket.emit('seek', { currentTime: 0 });
});

// Loop
document.getElementById('loop-btn').addEventListener('click', () => {
  isLooping = !isLooping;
  audio.loop = isLooping;
  document.getElementById('loop-btn').classList.toggle('active', isLooping);
  showToast(isLooping ? '🔁 Loop enabled' : 'Loop disabled');
});

// Mute / Unmute
document.getElementById('volume-btn').addEventListener('click', () => {
  audio.muted = !audio.muted;
  document.getElementById('vol-on').classList.toggle('hidden', audio.muted);
  document.getElementById('vol-off').classList.toggle('hidden', !audio.muted);
});

// =============================================
// Progress Bar & Scrubbing
// =============================================

const progressBar = document.getElementById('progress-bar');

progressBar.addEventListener('click', (e) => {
  seekToPosition(e.clientX);
});

progressBar.addEventListener('mousedown', () => { isSeeking = true; });
document.addEventListener('mousemove', (e) => { if (isSeeking) seekToPosition(e.clientX); });
document.addEventListener('mouseup', endSeek);

progressBar.addEventListener('touchstart', (e) => {
  isSeeking = true;
  seekToPosition(e.touches[0].clientX);
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (isSeeking && e.touches[0]) seekToPosition(e.touches[0].clientX);
}, { passive: true });

document.addEventListener('touchend', endSeek);

function seekToPosition(clientX) {
  if (!currentTrack) return;
  const rect = progressBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const dur = audio.duration || localDuration || currentTrack.duration || 1;
  const targetTime = pct * dur;

  audio.currentTime = targetTime;
  updateProgressUI(targetTime, dur);
}

function endSeek() {
  if (isSeeking && currentTrack) {
    socket.emit('seek', { currentTime: audio.currentTime });
  }
  isSeeking = false;
}

// Native audio event listeners
audio.addEventListener('timeupdate', () => {
  if (isSeeking) return;
  const cur = audio.currentTime;
  const dur = audio.duration || localDuration || currentTrack?.duration || 0;
  if (dur > 0 && dur !== localDuration) {
    localDuration = dur;
    document.getElementById('total-time').textContent = formatTime(dur);
  }
  updateProgressUI(cur, dur);
});

audio.addEventListener('play', () => updatePlayButton(true));
audio.addEventListener('pause', () => updatePlayButton(false));
audio.addEventListener('ended', () => {
  if (!isLooping) {
    updatePlayButton(false);
    socket.emit('play-pause', { isPlaying: false, currentTime: audio.duration || 0 });
  }
});

function updateProgressUI(cur, dur) {
  if (dur > 0) {
    const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-thumb').style.left = pct + '%';
    document.getElementById('current-time').textContent = formatTime(cur);
    document.getElementById('mini-time').textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  }
}

function updatePlayButton(playing) {
  document.getElementById('play-icon').classList.toggle('hidden', playing);
  document.getElementById('pause-icon').classList.toggle('hidden', !playing);
  document.getElementById('mini-play-icon').textContent = playing ? '⏸' : '▶';

  document.querySelectorAll('#waveform span').forEach(bar => {
    bar.style.animationPlayState = playing ? 'running' : 'paused';
  });
}

// =============================================
// Real-Time Sync Handlers (Two-Way for Both Devices)
// =============================================

socket.on('track-changed', ({ track, currentTime, isPlaying }) => {
  loadTrack(track, currentTime, isPlaying !== false);
  showToast(`🎵 Now playing: ${track.title}`);
});

socket.on('sync-playback', ({ isPlaying, currentTime, serverTime }) => {
  const latency = Math.max(0, (Date.now() - serverTime) / 1000);
  const targetPos = isPlaying ? currentTime + latency : currentTime;

  if (Math.abs(audio.currentTime - targetPos) > 0.3) {
    audio.currentTime = targetPos;
  }

  if (isPlaying && audio.paused) {
    audio.play().then(() => updatePlayButton(true)).catch(showMobileSyncPrompt);
  } else if (!isPlaying && !audio.paused) {
    audio.pause();
    updatePlayButton(false);
  }
});

socket.on('sync-seek', ({ currentTime, isPlaying, serverTime }) => {
  const latency = Math.max(0, (Date.now() - serverTime) / 1000);
  const targetPos = isPlaying ? currentTime + latency : currentTime;

  audio.currentTime = targetPos;
  if (isPlaying && audio.paused) {
    audio.play().catch(() => {});
  }
});

socket.on('member-update', ({ memberCount }) => {
  document.getElementById('member-count').textContent = memberCount;
  if (memberCount > 1) {
    updateSyncStatus(`${memberCount} listeners in sync`, 'synced');
  }
});

socket.on('room-closed', ({ reason }) => {
  showToast(reason || 'Room closed.', 'error');
  setTimeout(() => window.location.href = '/', 2500);
});

// Periodic heartbeat sync to maintain tight timeline alignment
function startSyncHeartbeat() {
  if (syncInterval) clearInterval(syncInterval);

  syncInterval = setInterval(() => {
    if (!currentTrack || isSeeking) return;

    socket.emit('sync-request', (state) => {
      if (!state) return;

      const latency = Math.max(0, (Date.now() - state.serverTime) / 1000);
      const roomPos = state.isPlaying ? state.currentTime + latency : state.currentTime;
      const myPos = audio.currentTime;
      const offset = Math.abs(myPos - roomPos);

      // Realign timeline if drift exceeds 300ms
      if (offset > 0.3) {
        audio.currentTime = roomPos;
      }

      if (state.isPlaying && audio.paused) {
        audio.play().catch(() => {});
      } else if (!state.isPlaying && !audio.paused) {
        audio.pause();
      }

      if (offset < 0.08) {
        updateSyncStatus('Perfectly synchronized', 'synced');
      } else if (offset < 0.4) {
        updateSyncStatus(`In Sync • ${Math.round(offset * 1000)}ms offset`, 'synced');
      } else {
        updateSyncStatus(`Aligning… ${Math.round(offset * 1000)}ms offset`, 'syncing');
      }
    });
  }, 2500);
}

// =============================================
// Reactions
// =============================================

document.querySelectorAll('.reaction-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const emoji = btn.dataset.emoji;
    socket.emit('reaction', emoji);
    spawnFloatingEmoji(emoji);

    btn.style.transform = 'scale(1.3)';
    setTimeout(() => btn.style.transform = '', 180);
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
  el.style.left = (15 + Math.random() * 70) + '%';
  el.style.animationDuration = (1.6 + Math.random() * 0.8) + 's';
  container.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// =============================================
// Mobile Prompt & Helpers
// =============================================

function showMobileSyncPrompt() {
  const overlay = document.getElementById('sync-prompt-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function hideMobileSyncPrompt() {
  const overlay = document.getElementById('sync-prompt-overlay');
  if (overlay) overlay.classList.add('hidden');
}

const syncBtn = document.getElementById('sync-prompt-btn');
if (syncBtn) {
  syncBtn.addEventListener('click', () => {
    audio.play().then(() => {
      updatePlayButton(true);
      hideMobileSyncPrompt();
    }).catch(() => {
      hideMobileSyncPrompt();
    });
  });
}

document.getElementById('copy-room-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    showToast('📋 Room code copied!');
  }).catch(() => {
    showToast('📋 Room code: ' + roomCode);
  });
});

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

function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
