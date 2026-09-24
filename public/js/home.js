// =============================================
// SyncTune — Home Page Logic
// =============================================

let generatedCode = null;

// Generate a 6-char room code (client-side, just for display)
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ---- Create Room ----
document.getElementById('create-room-btn').addEventListener('click', () => {
  generatedCode = generateCode();
  document.getElementById('generated-code').textContent = generatedCode;
  document.getElementById('room-code-display').classList.remove('hidden');
  document.getElementById('create-room-btn').classList.add('hidden');
  document.getElementById('enter-room-btn').classList.remove('hidden');
  showToast('✅ Room created! Share the code with your friend.');
});

// ---- Enter Room (Host) ----
document.getElementById('enter-room-btn').addEventListener('click', () => {
  if (generatedCode) {
    window.location.href = `/room?code=${generatedCode}&role=host`;
  }
});

// ---- Copy Code ----
document.getElementById('copy-code').addEventListener('click', () => {
  if (!generatedCode) return;
  navigator.clipboard.writeText(generatedCode).then(() => {
    showToast('📋 Code copied to clipboard!');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = generatedCode;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('📋 Code copied!');
  });
});

// ---- Join Room (Guest) ----
document.getElementById('join-room-btn').addEventListener('click', joinRoom);
document.getElementById('room-code-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinRoom();
});

function joinRoom() {
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!code || code.length < 4) {
    showToast('Please enter a valid room code', 'error');
    return;
  }
  window.location.href = `/room?code=${code}&role=guest`;
}

// ---- Auto-uppercase input ----
document.getElementById('room-code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// ---- Toast ----
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.className = 'toast hidden';
  }, 3000);
}
