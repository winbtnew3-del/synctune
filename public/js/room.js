// =============================================
// SyncTune — Room Logic with YouTube IFrame Player
// =============================================

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || '').toUpperCase().trim();
const role = params.get('role') || 'guest';

if (!roomCode) {
  window.location.href = '/';
}

const socket = io();
const isHost = role === 'host';

let ytPlayer = null;
let ytReady = false;
let currentTrack = null;
let isLooping = false;
let syncInterval = null;
let progressUpdateTimer = null;
let isSeeking = false;
let lastKnownDuration = 0;

// Update UI badges
document.getElementById('header-room-code').textContent = roomCode;

if (isHost) {
  document.getElementById('role-icon').textContent = '👑';
  document.getElementById('role-label').textContent = 'Host';
  document.getElementById('role-badge').classList.add('host');
  document.getElementById('track-input').classList.remove('hidden');
  document.getElementById('empty-title').textContent = 'Paste a YouTube link above';
  document.getElementById('empty-subtitle').textContent = 'Your music will stream in perfect sync for everyone';
} else {
  document.getElementById('role-icon').textContent = '🎧';
  document.getElementById('role-label').textContent = 'Guest';
  document.getElementById('role-badge').classList.add('guest');
  document.getElementById('empty-title').textContent = 'Waiting for host to play music...';
  document.getElementById('empty-subtitle').textContent = 'You will hear the track automatically when the host plays';
}

// =============================================
// YouTube IFrame Player API Setup
// =============================================

window.onYouTubeIframeAPIReady = function() {
  initYouTubePlayer();
};

// In case the API script loaded before the callback was attached
if (window.YT && window.YT.Player) {
  initYouTubePlayer();
}

function initYouTubePlayer() {
  if (ytPlayer || !window.YT || !window.YT.Player) return;

  ytPlayer = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 1,
      controls: 0,
      disablekb: 1,
      enablejsapi: 1,
      fs: 0,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      playsinline: 1,
      origin: window.location.origin
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError
    }
  });
}

function onPlayerReady() {
  ytReady = true;
  console.log('[SyncTune] YouTube player ready');
  startProgressTracker();

  // If a track was queued while loading
  if (currentTrack) {
    applyTrackToPlayer(currentTrack);
  }
}

function onPlayerStateChange(event) {
  const state = event.data;

  // YT.PlayerState.PLAYING = 1
  // YT.PlayerState.PAUSED = 2
  // YT.PlayerState.ENDED = 0

  if (state === 1) { // Playing
    updatePlayButton(true);
    const dur = ytPlayer.getDuration() || 0;
    if (dur > 0) {
      lastKnownDuration = dur;
      document.getElementById('total-time').textContent = formatTime(dur);
    }
    hideMobileSyncPrompt();
  } else if (state === 2) { // Paused
    updatePlayButton(false);
  } else if (state === 0) { // Ended
    if (isLooping && ytPlayer) {
      ytPlayer.seekTo(0, true);
      ytPlayer.playVideo();
    } else {
      updatePlayButton(false);
      if (isHost) {
        socket.emit('play-pause', { isPlaying: false, currentTime: lastKnownDuration });
      }
    }
  }
}

function onPlayerError(e) {
  console.warn('[SyncTune] YouTube player error:', e.data);
  // Error 150/101 = restricted playback, show friendly notice
  if (e.data === 150 || e.data === 101) {
    showToast('This specific video has playback restrictions. Please try another link!', 'error');
  }
}

// =============================================
// Socket.IO Room Connection
// =============================================

socket.on('connect', () => {
  console.log('[SyncTune] Connected to server, socket:', socket.id);

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
      showToast(res?.error || 'Room not found. Check the code and try again.', 'error');
      setTimeout(() => window.location.href = '/', 2500);
    }
  });
}

function onRoomJoined(res) {
  console.log('[SyncTune] Joined room:', res.code, 'as', res.role);
  updateSyncStatus(isHost ? 'Room ready — waiting for friends' : 'Connected to room', 'synced');

  if (res.state?.memberCount) {
    document.getElementById('member-count').textContent = res.state.memberCount;
  }

  // Load existing track if any
  if (!isHost && res.state?.currentTrack) {
    loadTrack(res.state.currentTrack, res.state.currentTime || 0, res.state.isPlaying !== false);
  }

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
    showToast('Invalid YouTube link. Please paste a valid YouTube URL.', 'error');
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
      artist: info.artist || 'YouTube',
      thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: info.duration || 0
    };

    setTrack(trackData);
    socket.emit('change-track', trackData);
    showToast(`🎵 Playing: ${trackData.title}`);
  } catch (err) {
    console.error('[Load Track]', err);
    // Fallback: load directly using video ID
    const fallbackTrack = {
      videoId,
      title: 'YouTube Track',
      artist: 'YouTube',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: 0
    };
    setTrack(fallbackTrack);
    socket.emit('change-track', fallbackTrack);
    showToast('Loaded track!');
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

  // Update UI metadata
  document.getElementById('track-title').textContent = trackData.title;
  document.getElementById('track-artist').textContent = trackData.artist;
  document.getElementById('track-thumbnail').src = trackData.thumbnail;
  document.getElementById('mini-title').textContent = trackData.title;

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
  document.getElementById('player-controls').classList.remove('hidden');

  applyTrackToPlayer(trackData, 0, true);
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

  applyTrackToPlayer(trackData, startTime, autoPlay);
}

function applyTrackToPlayer(trackData, startTime = 0, autoPlay = true) {
  if (!ytReady || !ytPlayer) {
    setTimeout(() => applyTrackToPlayer(trackData, startTime, autoPlay), 200);
    return;
  }

  try {
    if (autoPlay) {
      ytPlayer.loadVideoById({
        videoId: trackData.videoId,
        startSeconds: startTime || 0
      });
      updatePlayButton(true);
    } else {
      ytPlayer.cueVideoById({
        videoId: trackData.videoId,
        startSeconds: startTime || 0
      });
      updatePlayButton(false);
    }
  } catch (err) {
    console.error('[SyncTune] Error loading video into player:', err);
  }
}

// =============================================
// Controls & Actions
// =============================================

// Play / Pause
document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);

function togglePlayPause() {
  if (!ytPlayer || !ytReady) return;

  const playerState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
  const isCurrentlyPlaying = playerState === 1;

  if (isCurrentlyPlaying) {
    ytPlayer.pauseVideo();
    updatePlayButton(false);
    if (isHost) {
      const cur = ytPlayer.getCurrentTime() || 0;
      socket.emit('play-pause', { isPlaying: false, currentTime: cur });
    }
  } else {
    ytPlayer.playVideo();
    updatePlayButton(true);
    if (isHost) {
      const cur = ytPlayer.getCurrentTime() || 0;
      socket.emit('play-pause', { isPlaying: true, currentTime: cur });
    }
  }
}

// Skip Back / Restart
document.getElementById('skip-back-btn').addEventListener('click', () => {
  if (!ytPlayer || !ytReady) return;
  ytPlayer.seekTo(0, true);
  if (isHost) {
    socket.emit('seek', { currentTime: 0 });
  }
});

// Loop
document.getElementById('loop-btn').addEventListener('click', () => {
  isLooping = !isLooping;
  document.getElementById('loop-btn').classList.toggle('active', isLooping);
  showToast(isLooping ? '🔁 Loop enabled' : 'Loop disabled');
});

// Mute / Unmute
document.getElementById('volume-btn').addEventListener('click', () => {
  if (!ytPlayer || !ytReady) return;
  if (ytPlayer.isMuted()) {
    ytPlayer.unMute();
    document.getElementById('vol-on').classList.remove('hidden');
    document.getElementById('vol-off').classList.add('hidden');
  } else {
    ytPlayer.mute();
    document.getElementById('vol-on').classList.add('hidden');
    document.getElementById('vol-off').classList.remove('hidden');
  }
});

// =============================================
// Progress Bar & Slider
// =============================================

const progressBar = document.getElementById('progress-bar');

progressBar.addEventListener('click', (e) => {
  seekToPosition(e.clientX);
});

progressBar.addEventListener('mousedown', () => { isSeeking = true; });
document.addEventListener('mousemove', (e) => { if (isSeeking) seekToPosition(e.clientX); });
document.addEventListener('mouseup', endSeek);

// Touch drag for mobile
progressBar.addEventListener('touchstart', (e) => {
  isSeeking = true;
  seekToPosition(e.touches[0].clientX);
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (isSeeking && e.touches[0]) {
    seekToPosition(e.touches[0].clientX);
  }
}, { passive: true });

document.addEventListener('touchend', endSeek);

function seekToPosition(clientX) {
  if (!ytPlayer || !ytReady) return;
  const rect = progressBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const dur = ytPlayer.getDuration() || lastKnownDuration || 1;
  const targetTime = pct * dur;

  ytPlayer.seekTo(targetTime, true);
  updateProgressBar(targetTime, dur);
}

function endSeek() {
  if (isSeeking && ytPlayer && isHost) {
    const cur = ytPlayer.getCurrentTime() || 0;
    socket.emit('seek', { currentTime: cur });
  }
  isSeeking = false;
}

function startProgressTracker() {
  if (progressUpdateTimer) clearInterval(progressUpdateTimer);

  progressUpdateTimer = setInterval(() => {
    if (!ytPlayer || !ytReady || isSeeking) return;

    try {
      const cur = ytPlayer.getCurrentTime() || 0;
      const dur = ytPlayer.getDuration() || lastKnownDuration || 0;
      if (dur > 0 && dur !== lastKnownDuration) {
        lastKnownDuration = dur;
        document.getElementById('total-time').textContent = formatTime(dur);
      }
      updateProgressBar(cur, dur);
    } catch (e) {
      // ignore
    }
  }, 300);
}

function updateProgressBar(cur, dur) {
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

  // Toggle waveform animation
  document.querySelectorAll('#waveform span').forEach(bar => {
    bar.style.animationPlayState = playing ? 'running' : 'paused';
  });
}

// =============================================
// Real-Time Sync Handlers (Guest)
// =============================================

socket.on('track-changed', ({ track, currentTime, isPlaying }) => {
  loadTrack(track, currentTime, isPlaying !== false);
  showToast(`🎵 Now playing: ${track.title}`);
});

socket.on('sync-playback', ({ isPlaying, currentTime, serverTime }) => {
  if (isHost || !ytPlayer || !ytReady) return;

  const latency = Math.max(0, (Date.now() - serverTime) / 1000);
  const targetPos = isPlaying ? currentTime + latency : currentTime;
  const currentPos = ytPlayer.getCurrentTime() || 0;

  if (Math.abs(currentPos - targetPos) > 0.4) {
    ytPlayer.seekTo(targetPos, true);
  }

  if (isPlaying) {
    ytPlayer.playVideo();
    updatePlayButton(true);
  } else {
    ytPlayer.pauseVideo();
    updatePlayButton(false);
  }
});

socket.on('sync-seek', ({ currentTime, isPlaying, serverTime }) => {
  if (isHost || !ytPlayer || !ytReady) return;

  const latency = Math.max(0, (Date.now() - serverTime) / 1000);
  const targetPos = isPlaying ? currentTime + latency : currentTime;

  ytPlayer.seekTo(targetPos, true);
  if (isPlaying) ytPlayer.playVideo();
});

socket.on('member-update', ({ memberCount }) => {
  document.getElementById('member-count').textContent = memberCount;
  if (memberCount > 1) {
    updateSyncStatus(`${memberCount} listeners in sync`, 'synced');
  }
});

socket.on('room-closed', ({ reason }) => {
  showToast(reason || 'Room closed by host.', 'error');
  setTimeout(() => window.location.href = '/', 2500);
});

// Periodic heartbeat to guarantee sub-second alignment
function startSyncLoop() {
  if (isHost || syncInterval) return;

  syncInterval = setInterval(() => {
    if (!currentTrack || !ytPlayer || !ytReady) return;

    socket.emit('sync-request', (state) => {
      if (!state) return;

      const latency = Math.max(0, (Date.now() - state.serverTime) / 1000);
      const hostPos = state.isPlaying ? state.currentTime + latency : state.currentTime;
      const myPos = ytPlayer.getCurrentTime() || 0;
      const offset = Math.abs(myPos - hostPos);

      // Realign if drift exceeds 0.5s
      if (offset > 0.5) {
        ytPlayer.seekTo(hostPos, true);
      }

      const playerState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
      if (state.isPlaying && playerState !== 1) {
        ytPlayer.playVideo();
        updatePlayButton(true);
      } else if (!state.isPlaying && playerState === 1) {
        ytPlayer.pauseVideo();
        updatePlayButton(false);
      }

      if (offset < 0.1) {
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

    btn.style.transform = 'scale(1.35)';
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
  el.style.animationDuration = (1.5 + Math.random() * 0.8) + 's';
  container.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// =============================================
// Mobile Autoplay Helper Overlay
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
    if (ytPlayer && ytReady) {
      ytPlayer.playVideo();
    }
    hideMobileSyncPrompt();
  });
}

// Copy Room Code
document.getElementById('copy-room-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    showToast('📋 Room code copied!');
  }).catch(() => {
    showToast('📋 Room code: ' + roomCode);
  });
});

// =============================================
// Helper Utilities
// =============================================

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
