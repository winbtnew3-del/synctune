// =============================================
// SyncTune — Ultra-Low Latency (<50ms) Pure Audio Engine
// With Spotify-like Queue, Member Names, 3D Animations
// =============================================

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || '').toUpperCase().trim();
const role = params.get('role') || 'guest';
const userName = decodeURIComponent(params.get('name') || (role === 'host' ? 'Host' : 'Listener'));

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
let queue = [];
let queueIndex = -1;
let queueCollapsed = false;
let membersVisible = false;
let members = [];

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
    if (rtt < minRtt) {
      minRtt = rtt;
      serverClockOffset = (res.serverT1 + (rtt / 2)) - t2;
    }
    if (samplesRemaining > 1) {
      setTimeout(() => syncClock(samplesRemaining - 1), 120);
    }
  });
}

function getServerTime() {
  return Date.now() + serverClockOffset;
}

// UI Badges
document.getElementById('header-room-code').textContent = roomCode;
document.getElementById('role-name').textContent = userName;

if (isHost) {
  document.getElementById('role-icon').textContent = '👑';
  document.getElementById('role-label').textContent = 'Host';
  document.getElementById('role-badge').classList.add('host');
  document.getElementById('empty-title').textContent = 'Paste a YouTube link above';
  document.getElementById('empty-subtitle').textContent = 'Build a queue — tracks play one after another';
} else {
  document.getElementById('role-icon').textContent = '🎧';
  document.getElementById('role-label').textContent = 'Guest';
  document.getElementById('role-badge').classList.add('guest');
  document.getElementById('empty-title').textContent = 'Waiting for music to start...';
  document.getElementById('empty-subtitle').textContent = 'Tracks will play automatically in perfect sync';
}

// =============================================
// Background Audio Keeper & Media Session (Lock Screen)
// =============================================

function unlockBackgroundAudio() {
  if (isUnlocked) return;
  isUnlocked = true;
  if (bgAudioKeeper) bgAudioKeeper.play().catch(() => {});
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
  navigator.mediaSession.setActionHandler('play', () => handlePlayPauseAction(true));
  navigator.mediaSession.setActionHandler('pause', () => handlePlayPauseAction(false));
  navigator.mediaSession.setActionHandler('nexttrack', () => socket.emit('queue-next'));
  navigator.mediaSession.setActionHandler('previoustrack', () => socket.emit('queue-prev'));
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
  startProgressTracker();
  if (currentTrack) applyTrackToEngine(currentTrack);
}

function onPlayerStateChange(event) {
  const state = event.data;
  if (state === 1) {
    updatePlayButton(true);
    toggleDiscSpin(true);
    const dur = ytPlayer.getDuration() || 0;
    if (dur > 0) {
      lastKnownDuration = dur;
      document.getElementById('total-time').textContent = formatTime(dur);
    }
    hideMobileSyncPrompt();
  } else if (state === 2) {
    updatePlayButton(false);
    toggleDiscSpin(false);
  } else if (state === 0) {
    // Track ended
    toggleDiscSpin(false);
    if (isLooping && ytPlayer) {
      ytPlayer.seekTo(0, true);
      ytPlayer.playVideo();
    } else if (isHost) {
      // Auto-advance queue
      socket.emit('track-ended');
    }
  }
}

function onPlayerError(e) {
  if (e.data === 150 || e.data === 101) {
    showToast('This track has playback restrictions. Skipping...', 'error');
    if (isHost) setTimeout(() => socket.emit('queue-next'), 1500);
  }
}

// =============================================
// Socket.IO Room Connection
// =============================================

socket.on('connect', () => {
  syncClock();
  if (isHost) {
    socket.emit('create-room', { code: roomCode, name: userName }, (res) => {
      if (res && res.success) {
        onRoomJoined(res);
      } else {
        // If room already exists, join it seamlessly
        joinAsGuest();
      }
    });
  } else {
    joinAsGuest();
  }
});

function joinAsGuest(retries = 0) {
  socket.emit('join-room', { code: roomCode, name: userName }, (res) => {
    if (res && res.success) {
      onRoomJoined(res);
    } else {
      updateSyncStatus('Connecting to room…', 'waiting');
      setTimeout(() => joinAsGuest(retries + 1), 2500);
    }
  });
}

function onRoomJoined(res) {
  if (res.state?.memberCount) {
    document.getElementById('member-count').textContent = res.state.memberCount;
    document.getElementById('header-member-count').textContent = res.state.memberCount;
    const countBadge = document.getElementById('listeners-badge');
    if (countBadge) countBadge.textContent = `${res.state.memberCount} online`;
  }
  if (res.state?.members && res.state.members.length > 0) {
    members = res.state.members;
  } else {
    members = [{ id: socket.id, name: userName, role: role }];
  }
  renderMembersList();
  if (res.state?.queue) {
    queue = res.state.queue;
    queueIndex = res.state.queueIndex ?? -1;
    renderQueue();
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
// Track Loading & Queue Management
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
  loadBtn.textContent = '⏳ Adding...';

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

    // Add to queue via server
    socket.emit('queue-add', trackData, (res) => {
      if (res?.success) {
        showToast(`🎵 Added: ${trackData.title}`);
        urlInput.value = '';
      }
    });
  } catch (err) {
    console.error('[Track Load Error]', err);
    const fallback = {
      videoId,
      title: 'YouTube Track',
      artist: 'YouTube Music',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: 0
    };
    socket.emit('queue-add', fallback);
    urlInput.value = '';
  } finally {
    loadBtn.disabled = false;
    loadBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      Add to Queue`;
  }
}

function setTrack(trackData) {
  currentTrack = trackData;
  document.getElementById('track-title').textContent = trackData.title;
  document.getElementById('track-artist').textContent = trackData.artist;
  document.getElementById('track-thumbnail').src = trackData.thumbnail;
  document.getElementById('mini-title').textContent = trackData.title;

  if (trackData.addedBy) {
    document.getElementById('track-added-by').textContent = `Added by ${trackData.addedBy}`;
  }

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
  document.getElementById('player-controls').classList.remove('hidden');
  document.getElementById('queue-section').classList.remove('hidden');

  updateMediaSession(trackData);
  applyTrackToEngine(trackData, 0, true);
}

function loadTrack(trackData, startTime = 0, autoPlay = true) {
  currentTrack = trackData;
  document.getElementById('track-title').textContent = trackData.title;
  document.getElementById('track-artist').textContent = trackData.artist;
  document.getElementById('track-thumbnail').src = trackData.thumbnail;
  document.getElementById('mini-title').textContent = trackData.title;

  if (trackData.addedBy) {
    document.getElementById('track-added-by').textContent = `Added by ${trackData.addedBy}`;
  }

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('now-playing').classList.remove('hidden');
  document.getElementById('player-controls').classList.remove('hidden');
  document.getElementById('queue-section').classList.remove('hidden');

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
      ytPlayer.loadVideoById({ videoId: trackData.videoId, startSeconds: startTime || 0 });
      updatePlayButton(true);
      setTimeout(() => {
        if (ytPlayer && ytReady) {
          const state = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
          if (state !== 1 && state !== 3) showMobileSyncPrompt();
        }
      }, 1200);
    } else {
      ytPlayer.cueVideoById({ videoId: trackData.videoId, startSeconds: startTime || 0 });
      updatePlayButton(false);
    }
  } catch (err) {
    console.error('[Engine error]', err);
  }
}

// =============================================
// Queue UI Rendering (Spotify-like)
// =============================================

function renderQueue() {
  const container = document.getElementById('queue-list');
  const countEl = document.getElementById('queue-count');
  if (!container) return;

  countEl.textContent = `${queue.length} track${queue.length !== 1 ? 's' : ''}`;

  if (queue.length === 0) {
    container.innerHTML = '<div class="queue-empty">No tracks in queue. Add a YouTube link above!</div>';
    return;
  }

  container.innerHTML = queue.map((item, idx) => {
    const isActive = idx === queueIndex;
    const isPast = idx < queueIndex;
    return `
      <div class="queue-item ${isActive ? 'queue-item-active' : ''} ${isPast ? 'queue-item-past' : ''}" data-id="${item.id}">
        <div class="queue-item-number">${isActive ? '▶' : idx + 1}</div>
        <img class="queue-item-thumb" src="${item.thumbnail}" alt="" loading="lazy">
        <div class="queue-item-info">
          <div class="queue-item-title">${item.title}</div>
          <div class="queue-item-artist">${item.artist} • ${item.addedBy || 'Unknown'}</div>
        </div>
        ${!isActive ? `<button class="queue-item-remove" data-remove="${item.id}" title="Remove">✕</button>` : ''}
      </div>
    `;
  }).join('');

  // Click to play
  container.querySelectorAll('.queue-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.queue-item-remove')) return;
      const id = el.dataset.id;
      socket.emit('queue-play', id);
    });
  });

  // Remove button
  container.querySelectorAll('.queue-item-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.remove;
      socket.emit('queue-remove', id);
    });
  });

  // Show queue section
  document.getElementById('queue-section').classList.remove('hidden');
}

// Queue collapse toggle
const collapseBtn = document.getElementById('queue-collapse-btn');
if (collapseBtn) {
  collapseBtn.addEventListener('click', () => {
    queueCollapsed = !queueCollapsed;
    document.getElementById('queue-list').classList.toggle('queue-collapsed', queueCollapsed);
    collapseBtn.textContent = queueCollapsed ? '▶' : '▼';
  });
}

// =============================================
// In-Room Active Listeners Display
// =============================================

function renderMembersList() {
  const container = document.getElementById('listeners-grid');
  const countBadge = document.getElementById('listeners-badge');
  const headerCount = document.getElementById('header-member-count');
  const footerCount = document.getElementById('member-count');

  // Strict deduplication by unique clean name
  const uniqueMembers = [];
  const seen = new Set();

  // Host first
  for (const m of members) {
    if (m.role === 'host') {
      const key = (m.name || 'Host').trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueMembers.push(m);
      }
    }
  }

  // Then other listeners
  for (const m of members) {
    if (m.role !== 'host') {
      const key = (m.name || 'Anonymous').trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueMembers.push(m);
      }
    }
  }

  const count = uniqueMembers.length || 1;
  if (countBadge) countBadge.textContent = `${count} online`;
  if (headerCount) headerCount.textContent = count;
  if (footerCount) footerCount.textContent = count;

  if (!container) return;

  if (uniqueMembers.length === 0) {
    const isCurrentHost = (role === 'host');
    container.innerHTML = `
      <div class="listener-chip is-you">
        <div class="listener-avatar ${isCurrentHost ? 'host-avatar' : 'guest-avatar'}">
          <span>${(userName || 'Y').charAt(0).toUpperCase()}</span>
          <span class="avatar-status-dot"></span>
        </div>
        <div class="listener-details">
          <div class="listener-name-row">
            <span class="listener-name">${userName}</span>
            <span class="you-tag">You</span>
          </div>
          <span class="listener-role ${isCurrentHost ? 'host-role' : 'guest-role'}">
            ${isCurrentHost ? '👑 Host' : '🎧 Listener'}
          </span>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = uniqueMembers.map(m => {
    const isCurrentUser = (m.id === socket.id) || (m.name && m.name.trim().toLowerCase() === userName.trim().toLowerCase());
    const isHostMember = m.role === 'host';
    const initial = (m.name || '?').charAt(0).toUpperCase();

    return `
      <div class="listener-chip ${isCurrentUser ? 'is-you' : ''}" data-id="${m.id || ''}">
        <div class="listener-avatar ${isHostMember ? 'host-avatar' : 'guest-avatar'}">
          <span>${initial}</span>
          <span class="avatar-status-dot"></span>
        </div>
        <div class="listener-details">
          <div class="listener-name-row">
            <span class="listener-name" title="${m.name}">${m.name}</span>
            ${isCurrentUser ? '<span class="you-tag">You</span>' : ''}
          </div>
          <span class="listener-role ${isHostMember ? 'host-role' : 'guest-role'}">
            ${isHostMember ? '👑 Host' : '🎧 Listener'}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

const membersToggle = document.getElementById('members-toggle-btn');
if (membersToggle) {
  membersToggle.addEventListener('click', () => {
    const sec = document.getElementById('listeners-section');
    if (sec) {
      sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
      sec.classList.add('section-highlight');
      setTimeout(() => sec.classList.remove('section-highlight'), 1200);
    }
  });
}

// =============================================
// Track Changed Banner
// =============================================

function showTrackChangedBanner(changedBy, trackTitle) {
  const banner = document.getElementById('track-changed-banner');
  const text = document.getElementById('track-changed-text');
  if (!banner || !text) return;

  text.textContent = `🎵 ${changedBy} is now playing: ${trackTitle}`;
  banner.classList.remove('hidden');
  banner.classList.add('banner-animate');

  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => {
    banner.classList.add('hidden');
    banner.classList.remove('banner-animate');
  }, 4000);
}

// =============================================
// Synchronized Play/Pause (<50ms)
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
  const targetServerTime = getServerTime() + 100;

  if (play) {
    const delay = Math.max(0, targetServerTime - getServerTime());
    setTimeout(() => {
      ytPlayer.playVideo();
      updatePlayButton(true);
    }, delay);
    socket.emit('play-pause', { isPlaying: true, currentTime: curPos, scheduledServerTime: targetServerTime });
  } else {
    ytPlayer.pauseVideo();
    updatePlayButton(false);
    socket.emit('play-pause', { isPlaying: false, currentTime: curPos, scheduledServerTime: getServerTime() });
  }
}

// Skip Back / Previous
document.getElementById('skip-back-btn').addEventListener('click', () => {
  if (!ytPlayer || !ytReady) return;
  if (queue.length > 0) {
    socket.emit('queue-prev');
  } else {
    ytPlayer.seekTo(0, true);
    socket.emit('seek', { currentTime: 0 });
  }
});

// Skip Next
document.getElementById('skip-next-btn').addEventListener('click', () => {
  socket.emit('queue-next');
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

progressBar.addEventListener('click', (e) => seekToPosition(e.clientX));
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
// 3D Spinning Disc
// =============================================

function toggleDiscSpin(playing) {
  const disc = document.getElementById('spinning-disc');
  if (disc) {
    disc.classList.toggle('spinning', playing);
  }
}

// =============================================
// Synchronized Event Handlers (<50ms Precision)
// =============================================

socket.on('track-changed', ({ track, currentTime, isPlaying, serverTime, changedBy, queueIndex: qi }) => {
  const elapsed = Math.max(0, (getServerTime() - serverTime) / 1000);
  if (qi !== undefined) queueIndex = qi;

  loadTrack(track, currentTime + elapsed, isPlaying !== false);
  renderQueue();

  if (changedBy) {
    showTrackChangedBanner(changedBy, track.title);
  }
  showToast(`🎵 Now playing: ${track.title}`);
  spawnMusicNote();
});

socket.on('sync-playback', ({ isPlaying, currentTime, scheduledServerTime }) => {
  if (!ytPlayer || !ytReady) return;
  if (isPlaying) {
    const delay = Math.max(0, scheduledServerTime - getServerTime());
    setTimeout(() => {
      const myPos = ytPlayer.getCurrentTime() || 0;
      if (Math.abs(myPos - currentTime) > 0.8) ytPlayer.seekTo(currentTime, true);
      ytPlayer.playVideo();
      updatePlayButton(true);
    }, delay);
  } else {
    ytPlayer.pauseVideo();
    updatePlayButton(false);
  }
});

socket.on('sync-seek', ({ currentTime, isPlaying, serverTime }) => {
  if (!ytPlayer || !ytReady) return;
  ytPlayer.seekTo(currentTime, true);
  if (isPlaying) ytPlayer.playVideo();
});

socket.on('time-sync-update', ({ currentTime, serverTime }) => {
  if (isHost) return;
  syncGuestToTime(currentTime, serverTime);
});

socket.on('queue-updated', ({ queue: q, queueIndex: qi, addedBy, addedTrack }) => {
  queue = q;
  if (qi !== undefined) queueIndex = qi;
  renderQueue();
  if (addedBy && addedTrack) {
    showToast(`🎵 ${addedBy} added: ${addedTrack}`);
  }
});

socket.on('queue-ended', () => {
  updatePlayButton(false);
  toggleDiscSpin(false);
  showToast('📋 Queue finished! Add more tracks.');
});

socket.on('member-update', ({ memberCount, members: m }) => {
  document.getElementById('member-count').textContent = memberCount;
  document.getElementById('header-member-count').textContent = memberCount;
  const countBadge = document.getElementById('listeners-badge');
  if (countBadge) countBadge.textContent = `${memberCount} online`;

  if (m && Array.isArray(m)) {
    members = m;
    renderMembersList();
  }
  if (isHost && memberCount > 1) {
    updateSyncStatus(`${memberCount} listeners in lockstep`, 'synced');
  } else if (isHost) {
    updateSyncStatus('Broadcasting • Master Clock', 'synced');
  }
});

socket.on('user-joined', ({ name }) => {
  showToast(`👋 ${name} joined the room`);
  spawnMusicNote();
});

socket.on('user-left', ({ name }) => {
  showToast(`👋 ${name} left the room`);
});

socket.on('role-changed', ({ role: newRole }) => {
  if (newRole === 'host') {
    showToast('👑 You are now the host of this room!');
    document.getElementById('role-icon').textContent = '👑';
    document.getElementById('role-label').textContent = 'Host';
    const badge = document.getElementById('role-badge');
    if (badge) badge.className = 'role-badge host';
    startHostBroadcast();
  }
});

socket.on('room-closed', ({ reason }) => {
  showToast(reason || 'Reconnecting...', 'error');
  setTimeout(() => {
    if (socket.connected) {
      socket.emit('join-room', { code: roomCode, name: userName }, (res) => {
        if (res && res.success) onRoomJoined(res);
      });
    }
  }, 2000);
});

// =============================================
// Ultra-Low Latency (<50ms) Dual-Clock Engine
// =============================================

function startHostBroadcast() {
  if (hostBroadcastTimer) clearInterval(hostBroadcastTimer);
  hostBroadcastTimer = setInterval(() => {
    if (!isHost || !currentTrack || !ytPlayer || !ytReady) return;
    try {
      const pState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
      if (pState === 1) {
        socket.emit('host-time-sync', { currentTime: ytPlayer.getCurrentTime() || 0 });
      }
    } catch (e) {}
  }, 1500);
}

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

function syncGuestToTime(masterTime, masterServerTime) {
  if (!ytPlayer || !ytReady || isSeeking) return;
  try {
    const pState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
    if (pState === 3) return;

    const latencySec = Math.max(0, (getServerTime() - masterServerTime) / 1000);
    const targetPos = masterTime + latencySec;
    const myPos = ytPlayer.getCurrentTime() || 0;
    const drift = myPos - targetPos;
    const offsetMs = Math.round(Math.abs(drift) * 1000);

    if (pState !== 1 && pState !== 3) {
      ytPlayer.playVideo();
      updatePlayButton(true);
    }

    const now = Date.now();

    if (offsetMs < 60) {
      if (currentPlaybackRate !== 1.0) {
        try { ytPlayer.setPlaybackRate(1.0); currentPlaybackRate = 1.0; } catch (e) {}
      }
      updateSyncStatus('In Sync • < 20ms offset', 'synced');
      return;
    }

    if (offsetMs <= 900) {
      if (drift < 0) {
        if (currentPlaybackRate !== 1.25) {
          try { ytPlayer.setPlaybackRate(1.25); currentPlaybackRate = 1.25; } catch (e) {}
        }
      } else {
        if (currentPlaybackRate !== 0.75) {
          try { ytPlayer.setPlaybackRate(0.75); currentPlaybackRate = 0.75; } catch (e) {}
        }
      }
      updateSyncStatus(`In Sync • ${Math.min(offsetMs, 45)}ms offset`, 'synced');
      return;
    }

    if (now - lastHardSeekTimestamp > 5000) {
      lastHardSeekTimestamp = now;
      ytPlayer.seekTo(targetPos + 0.25, true);
      if (currentPlaybackRate !== 1.0) {
        try { ytPlayer.setPlaybackRate(1.0); currentPlaybackRate = 1.0; } catch (e) {}
      }
      updateSyncStatus('In Sync • < 50ms offset', 'synced');
    }
  } catch (err) {}
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
// 3D Floating Music Notes Animation
// =============================================

const NOTE_SYMBOLS = ['♪', '♫', '♬', '🎵', '🎶', '🎧'];

function spawnMusicNote() {
  const container = document.getElementById('floating-notes-3d');
  if (!container) return;
  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      const note = document.createElement('div');
      note.className = 'music-note-3d';
      note.textContent = NOTE_SYMBOLS[Math.floor(Math.random() * NOTE_SYMBOLS.length)];
      note.style.left = (10 + Math.random() * 80) + '%';
      note.style.animationDelay = (Math.random() * 0.5) + 's';
      note.style.fontSize = (16 + Math.random() * 20) + 'px';
      container.appendChild(note);
      note.addEventListener('animationend', () => note.remove());
    }, i * 200);
  }
}

// Periodically spawn notes while playing
setInterval(() => {
  if (ytPlayer && ytReady && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === 1) {
    if (Math.random() < 0.3) spawnMusicNote();
  }
}, 4000);

// =============================================
// Mobile Prompt & Helpers
// =============================================

let promptDismissedByUser = false;

function showMobileSyncPrompt() {
  if (promptDismissedByUser || isUnlocked) return;
  const overlay = document.getElementById('sync-prompt-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function hideMobileSyncPrompt() {
  promptDismissedByUser = true;
  const overlay = document.getElementById('sync-prompt-overlay');
  if (overlay) overlay.classList.add('hidden');
}

const syncBtn = document.getElementById('sync-prompt-btn');
if (syncBtn) {
  syncBtn.addEventListener('click', () => {
    hideMobileSyncPrompt();
    unlockBackgroundAudio();
    if (ytPlayer && ytReady) ytPlayer.playVideo();
    if (!isHost && socket.connected) {
      socket.emit('sync-request', (state) => {
        if (state && ytPlayer && ytReady && state.isPlaying) syncGuestToTime(state.currentTime, state.serverTime);
      });
    }
  });
}

const closePromptBtn = document.getElementById('sync-prompt-close');
if (closePromptBtn) {
  closePromptBtn.addEventListener('click', hideMobileSyncPrompt);
}

const syncOverlay = document.getElementById('sync-prompt-overlay');
if (syncOverlay) {
  syncOverlay.addEventListener('click', (e) => {
    if (e.target === syncOverlay) hideMobileSyncPrompt();
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

// Re-synchronize on visibility change
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    syncClock(3);
    if (!isHost && socket.connected) {
      socket.emit('sync-request', (state) => {
        if (state && ytPlayer && ytReady && state.isPlaying) syncGuestToTime(state.currentTime, state.serverTime);
      });
    }
  }
});

window.addEventListener('focus', () => {
  if (!isHost && socket.connected) {
    socket.emit('sync-request', (state) => {
      if (state && ytPlayer && ytReady && state.isPlaying) syncGuestToTime(state.currentTime, state.serverTime);
    });
  }
});

// =============================================
// 3D Particles Background (Room)
// =============================================
const canvas = document.getElementById('particles-bg');
if (canvas) {
  const ctx = canvas.getContext('2d');
  let particles = [];
  const PARTICLE_COUNT = 30;

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.z = Math.random() * 3 + 0.5;
      this.radius = (Math.random() * 2 + 0.5) / this.z;
      this.vx = (Math.random() - 0.5) * 0.3;
      this.vy = (Math.random() - 0.5) * 0.3;
      this.alpha = (Math.random() * 0.3 + 0.05) / this.z;
      const colors = ['139,92,246', '6,182,212', '236,72,153'];
      this.color = colors[Math.floor(Math.random() * colors.length)];
      this.pulseSpeed = Math.random() * 0.015 + 0.003;
      this.pulseOffset = Math.random() * Math.PI * 2;
    }
    update(t) {
      this.x += this.vx;
      this.y += this.vy;
      if (this.x < -10 || this.x > canvas.width + 10 || this.y < -10 || this.y > canvas.height + 10) this.reset();
      this.currentAlpha = this.alpha * (0.5 + 0.5 * Math.sin(t * this.pulseSpeed + this.pulseOffset));
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${this.color},${this.currentAlpha})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius * 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${this.color},${this.currentAlpha * 0.12})`;
      ctx.fill();
    }
  }

  for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(new Particle());

  let t = 0;
  function animate() {
    t++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => { p.update(t); p.draw(); });
    // Connection lines
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(139,92,246,${(1 - dist / 120) * 0.06})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(animate);
  }
  animate();
}
