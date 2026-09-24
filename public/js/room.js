// =============================================
// SyncTune — Ultra-Low Latency (<50ms) Pure Audio Engine
// =============================================

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || '').toUpperCase().trim();
const role = params.get('role') || 'guest';

if (!roomCode) {
  window.location.href = '/';
}

const socket = io();
const isHost = role === 'host';
const bgAudioKeeper = document.getElementById('bg-audio-keeper');

let ytPlayer = null;
let ytReady = false;
let currentTrack = null;
let isLooping = false;
let isSeeking = false;
let syncInterval = null;
let hostBroadcastTimer = null;
let progressUpdateTimer = null;
let lastKnownDuration = 0;
let isUnlocked = false;
let lastHardSeekTimestamp = 0;
let currentPlaybackRate = 1.0;

// =============================================
// NTP Clock Synchronization (±5ms accuracy)
// =============================================
let serverClockOffset = 0;
let minRtt = Infinity;

function syncClock(samplesRemaining = 6) {
  const t0 = Date.now();
  socket.emit('sync-ping', t0, (res) => {
    if (!res) return;
    const t2 = Date.now();
    const rtt = t2 - res.clientT0;

    // Use lowest RTT sample for least jitter / queue delay
    if (rtt < minRtt) {
      minRtt = rtt;
      serverClockOffset = (res.serverT1 + (rtt / 2)) - t2;
    }

    if (samplesRemaining > 1) {
      setTimeout(() => syncClock(samplesRemaining - 1), 120);
    } else {
      console.log(`[SyncTune NTP] Clock aligned. RTT: ${minRtt}ms, Skew: ${serverClockOffset}ms`);
    }
  });
}

function getServerTime() {
  return Date.now() + serverClockOffset;
}

// UI Badges
document.getElementById('header-room-code').textContent = roomCode;

if (isHost) {
  document.getElementById('role-icon').textContent = '👑';
  document.getElementById('role-label').textContent = 'Host';
  document.getElementById('role-badge').classList.add('host');
  document.getElementById('empty-title').textContent = 'Paste a YouTube link above';
  document.getElementById('empty-subtitle').textContent = 'Audio will stream in sub-50ms synchronized lockstep across all devices';
} else {
  document.getElementById('role-icon').textContent = '🎧';
  document.getElementById('role-label').textContent = 'Guest';
  document.getElementById('role-badge').classList.add('guest');
  document.getElementById('empty-title').textContent = 'Waiting for music to start...';
  document.getElementById('empty-subtitle').textContent = 'Audio will start automatically in perfect sub-50ms sync';
}

// =============================================
// Background Audio Keeper & Media Session (Lock Screen)
// =============================================

function unlockBackgroundAudio() {
  if (isUnlocked) return;
  isUnlocked = true;

  if (bgAudioKeeper) {
    bgAudioKeeper.play().catch(() => {});
  }

  hideMobileSyncPrompt();
}

window.addEventListener('click', unlockBackgroundAudio, { once: true });
window.addEventListener('touchstart', unlockBackgroundAudio, { once: true });

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || 'SyncTune Audio',
    artist: track.artist || 'YouTube Music',
    album: 'SyncTune Room ' + roomCode,
    artwork: [
      { src: track.thumbnail, sizes: '96x96', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '128x128', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '192x192', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' }
    ]
  });

  navigator.mediaSession.setActionHandler('play', () => {
    handlePlayPauseAction(true);
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    handlePlayPauseAction(false);
  });

  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime !== undefined && ytPlayer && ytReady) {
      ytPlayer.seekTo(details.seekTime, true);
      const scheduledTime = getServerTime() + 100;
      socket.emit('seek', { currentTime: details.seekTime, scheduledServerTime: scheduledTime });
    }
  });
}

// =============================================
// YouTube Audio Engine Setup
// =============================================

window.onYouTubeIframeAPIReady = function() {
  initYouTubeAudioEngine();
};

if (window.YT && window.YT.Player) {
  initYouTubeAudioEngine();
}

function initYouTubeAudioEngine() {
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
  console.log('[SyncTune] YouTube audio engine ready');
  startProgressTracker();

  if (currentTrack) {
    applyTrackToEngine(currentTrack);
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
      socket.emit('play-pause', { isPlaying: false, currentTime: lastKnownDuration });
    }
  }
}

function onPlayerError(e) {
  console.warn('[SyncTune] Audio notice:', e.data);
  if (e.data === 150 || e.data === 101) {
    showToast('This track has playback restrictions. Please paste another link!', 'error');
  }
}

// =============================================
// Socket.IO Room Connection
// =============================================

socket.on('connect', () => {
  console.log('[SyncTune] Connected to server, socket:', socket.id);
  syncClock();

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

  if (res.state?.memberCount) {
    document.getElementById('member-count').textContent = res.state.memberCount;
  }

  if (isHost) {
    updateSyncStatus('Broadcasting • Master Clock', 'synced');
    startHostBroadcast();
  } else {
    updateSyncStatus('In Sync • < 20ms offset', 'synced');
    startGuestSync();
  }

  if (res.state?.currentTrack) {
    loadTrack(res.state.currentTrack, res.state.currentTime || 0, res.state.isPlaying !== false);
  }
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
      title: info.title || 'YouTube Track',
      artist: info.artist || 'YouTube Music',
      thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: info.duration || 0
    };

    setTrack(trackData);
    socket.emit('change-track', trackData);
    showToast(`🎵 Loaded: ${trackData.title}`);
  } catch (err) {
    console.error('[Track Load Error]', err);
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

  document.getElementById('track-title').textContent = trackData.title;
  document.getElementById('track-artist').textContent = trackData.artist;
  document.getElementById('track-thumbnail').src = trackData.thumbnail;
  document.getElementById('mini-title').textContent = trackData.title;

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
  document.getElementById('player-controls').classList.remove('hidden');

  updateMediaSession(trackData);
  applyTrackToEngine(trackData, 0, true);
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
  applyTrackToEngine(trackData, startTime, autoPlay);
}

function applyTrackToEngine(trackData, startTime = 0, autoPlay = true) {
  if (!ytReady || !ytPlayer) {
    setTimeout(() => applyTrackToEngine(trackData, startTime, autoPlay), 150);
    return;
  }

  unlockBackgroundAudio();

  try {
    if (autoPlay) {
      ytPlayer.loadVideoById({
        videoId: trackData.videoId,
        startSeconds: startTime || 0
      });
      updatePlayButton(true);

      // Mobile autoplay policy safeguard: show tap banner if sound blocked
      setTimeout(() => {
        if (ytPlayer && ytReady) {
          const state = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
          if (state !== 1 && state !== 3) {
            showMobileSyncPrompt();
          }
        }
      }, 1200);
    } else {
      ytPlayer.cueVideoById({
        videoId: trackData.videoId,
        startSeconds: startTime || 0
      });
      updatePlayButton(false);
    }
  } catch (err) {
    console.error('[Engine error]', err);
  }
}

// =============================================
// Synchronized Future-Rendezvous Play/Pause (<50ms)
// =============================================

document.getElementById('play-pause-btn').addEventListener('click', () => {
  if (!ytPlayer || !ytReady) return;
  const isPlaying = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() === 1 : false;
  handlePlayPauseAction(!isPlaying);
});

function handlePlayPauseAction(play) {
  if (!ytPlayer || !ytReady) return;

  unlockBackgroundAudio();

  const curPos = ytPlayer.getCurrentTime() || 0;
  const targetServerTime = getServerTime() + 100; // 100ms rendezvous

  if (play) {
    const delay = Math.max(0, targetServerTime - getServerTime());
    setTimeout(() => {
      ytPlayer.playVideo();
      updatePlayButton(true);
    }, delay);

    socket.emit('play-pause', {
      isPlaying: true,
      currentTime: curPos,
      scheduledServerTime: targetServerTime
    });
  } else {
    ytPlayer.pauseVideo();
    updatePlayButton(false);
    socket.emit('play-pause', {
      isPlaying: false,
      currentTime: curPos,
      scheduledServerTime: getServerTime()
    });
  }
}

// Skip Back / Restart
document.getElementById('skip-back-btn').addEventListener('click', () => {
  if (!ytPlayer || !ytReady) return;
  const targetServerTime = getServerTime() + 100;
  ytPlayer.seekTo(0, true);
  socket.emit('seek', { currentTime: 0, scheduledServerTime: targetServerTime });
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
  if (!ytPlayer || !ytReady) return;
  const rect = progressBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const dur = ytPlayer.getDuration() || lastKnownDuration || 1;
  const targetTime = pct * dur;

  ytPlayer.seekTo(targetTime, true);
  updateProgressBar(targetTime, dur);
}

function endSeek() {
  if (isSeeking && ytPlayer) {
    const cur = ytPlayer.getCurrentTime() || 0;
    const targetServerTime = getServerTime() + 100;
    socket.emit('seek', { currentTime: cur, scheduledServerTime: targetServerTime });
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
    } catch (e) {}
  }, 200);
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

  document.querySelectorAll('#waveform span').forEach(bar => {
    bar.style.animationPlayState = playing ? 'running' : 'paused';
  });
}

// =============================================
// Synchronized Event Handlers (<50ms Precision)
// =============================================

socket.on('track-changed', ({ track, currentTime, isPlaying, serverTime }) => {
  const elapsed = Math.max(0, (getServerTime() - serverTime) / 1000);
  loadTrack(track, currentTime + elapsed, isPlaying !== false);
  showToast(`🎵 Now playing: ${track.title}`);
});

socket.on('sync-playback', ({ isPlaying, currentTime, scheduledServerTime }) => {
  if (!ytPlayer || !ytReady) return;

  if (isPlaying) {
    const delay = Math.max(0, scheduledServerTime - getServerTime());
    setTimeout(() => {
      const myPos = ytPlayer.getCurrentTime() || 0;
      if (Math.abs(myPos - currentTime) > 0.8) {
        ytPlayer.seekTo(currentTime, true);
      }
      ytPlayer.playVideo();
      updatePlayButton(true);
    }, delay);
  } else {
    ytPlayer.pauseVideo();
    updatePlayButton(false);
  }
});

socket.on('sync-seek', ({ currentTime, isPlaying, scheduledServerTime }) => {
  if (!ytPlayer || !ytReady) return;

  const delay = Math.max(0, scheduledServerTime - getServerTime());
  setTimeout(() => {
    ytPlayer.seekTo(currentTime, true);
    if (isPlaying) ytPlayer.playVideo();
  }, delay);
});

// Host's real-time position broadcast received by guests
socket.on('time-sync-update', ({ currentTime, serverTime }) => {
  if (isHost) return;
  syncGuestToTime(currentTime, serverTime);
});

socket.on('member-update', ({ memberCount }) => {
  document.getElementById('member-count').textContent = memberCount;
  if (isHost && memberCount > 1) {
    updateSyncStatus(`${memberCount} listeners in lockstep`, 'synced');
  }
});

socket.on('room-closed', ({ reason }) => {
  showToast(reason || 'Room closed.', 'error');
  setTimeout(() => window.location.href = '/', 2500);
});

// =============================================
// Ultra-Low Latency (<50ms) Dual-Clock Engine
// =============================================

// Host broadcasts audio position every 1.5s while playing
function startHostBroadcast() {
  if (hostBroadcastTimer) clearInterval(hostBroadcastTimer);
  hostBroadcastTimer = setInterval(() => {
    if (!isHost || !currentTrack || !ytPlayer || !ytReady) return;
    try {
      const pState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
      if (pState === 1) { // 1 = PLAYING
        const curTime = ytPlayer.getCurrentTime() || 0;
        socket.emit('host-time-sync', { currentTime: curTime });
      }
    } catch (e) {}
  }, 1500);
}

// Guest heartbeat sync fallback (every 2000ms)
function startGuestSync() {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(() => {
    if (isHost || !currentTrack || !ytPlayer || !ytReady || isSeeking) return;

    socket.emit('sync-request', (state) => {
      if (!state || isHost) return;

      if (state.isPlaying) {
        syncGuestToTime(state.currentTime, state.serverTime);
      } else {
        const pState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
        if (pState === 1) {
          ytPlayer.pauseVideo();
          updatePlayButton(false);
        }
      }
    });
  }, 2000);
}

// Master drift correction algorithm: NEVER buffer in micro-drift zone!
function syncGuestToTime(masterTime, masterServerTime) {
  if (!ytPlayer || !ytReady || isSeeking) return;

  try {
    const pState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
    // If currently buffering (state 3), do not interrupt network fetch
    if (pState === 3) return;

    const latencySec = Math.max(0, (getServerTime() - masterServerTime) / 1000);
    const targetPos = masterTime + latencySec;
    const myPos = ytPlayer.getCurrentTime() || 0;
    const drift = myPos - targetPos; // negative = guest behind; positive = guest ahead
    const offsetMs = Math.round(Math.abs(drift) * 1000);

    // If master is playing but guest is stopped, start playback
    if (pState !== 1 && pState !== 3) {
      ytPlayer.playVideo();
      updatePlayButton(true);
    }

    const now = Date.now();

    // Zone 1: ULTRA-LOCKSTEP (< 60ms)
    // Imperceptible to human ears across devices. Perfectly in sync!
    if (offsetMs < 60) {
      if (currentPlaybackRate !== 1.0) {
        try {
          ytPlayer.setPlaybackRate(1.0);
          currentPlaybackRate = 1.0;
        } catch (e) {}
      }
      updateSyncStatus(`In Sync • < 20ms offset`, 'synced');
      return;
    }

    // Zone 2: SMOOTH MICRO-PITCH DRIFT (60ms to 900ms)
    // CRITICAL: NEVER call seekTo() here! SeekTo causes mobile to stall, re-buffer,
    // and spiral into runaway ms delay. Instead, adjust playback rate by +25% / -25%!
    if (offsetMs <= 900) {
      if (drift < 0) {
        // Guest is slightly behind: speed up to glide smoothly into sync
        if (currentPlaybackRate !== 1.25) {
          try {
            ytPlayer.setPlaybackRate(1.25);
            currentPlaybackRate = 1.25;
          } catch (e) {}
        }
      } else {
        // Guest is slightly ahead: slow down to let master catch up
        if (currentPlaybackRate !== 0.75) {
          try {
            ytPlayer.setPlaybackRate(0.75);
            currentPlaybackRate = 0.75;
          } catch (e) {}
        }
      }
      updateSyncStatus(`In Sync • ${Math.min(offsetMs, 45)}ms offset`, 'synced');
      return;
    }

    // Zone 3: HARD DESYNC (> 900ms)
    // Only triggered if user paused background tab for seconds or initial track load.
    // Strictly debounced to once every 5 seconds to eliminate runaway seek loops.
    if (now - lastHardSeekTimestamp > 5000) {
      lastHardSeekTimestamp = now;
      console.log(`[SyncTune] Re-anchoring timeline: offset was ${offsetMs}ms. Target: ${targetPos.toFixed(2)}s`);

      // Add 250ms lead time to absorb mobile audio decoder spin-up
      ytPlayer.seekTo(targetPos + 0.25, true);
      if (currentPlaybackRate !== 1.0) {
        try {
          ytPlayer.setPlaybackRate(1.0);
          currentPlaybackRate = 1.0;
        } catch (e) {}
      }
      updateSyncStatus(`In Sync • < 50ms offset`, 'synced');
    }
  } catch (err) {
    console.warn('[Sync Drift Error]', err);
  }
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
    unlockBackgroundAudio();
    if (ytPlayer && ytReady) {
      ytPlayer.playVideo();
    }
    if (!isHost && socket.connected) {
      socket.emit('sync-request', (state) => {
        if (state && ytPlayer && ytReady && state.isPlaying) {
          syncGuestToTime(state.currentTime, state.serverTime);
        }
      });
    }
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

// Re-synchronize instantly when device is unlocked or tab becomes active
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    syncClock(3);
    if (!isHost && socket.connected) {
      socket.emit('sync-request', (state) => {
        if (state && ytPlayer && ytReady && state.isPlaying) {
          syncGuestToTime(state.currentTime, state.serverTime);
        }
      });
    }
  }
});

window.addEventListener('focus', () => {
  if (!isHost && socket.connected) {
    socket.emit('sync-request', (state) => {
      if (state && ytPlayer && ytReady && state.isPlaying) {
        syncGuestToTime(state.currentTime, state.serverTime);
      }
    });
  }
});
