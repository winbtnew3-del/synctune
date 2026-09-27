// =============================================
// SyncTune — Home Page Logic
// =============================================

let generatedCode = null;

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
  const name = document.getElementById('host-name-input').value.trim();
  if (!name) {
    showToast('Please enter your name first!', 'error');
    document.getElementById('host-name-input').focus();
    return;
  }
  generatedCode = generateCode();
  document.getElementById('generated-code').textContent = generatedCode;
  document.getElementById('room-code-display').classList.remove('hidden');
  document.getElementById('create-room-btn').classList.add('hidden');
  document.getElementById('enter-room-btn').classList.remove('hidden');
  showToast('✅ Room created! Share the code with your friends.');
});

// ---- Enter Room (Host) ----
document.getElementById('enter-room-btn').addEventListener('click', () => {
  if (generatedCode) {
    const name = encodeURIComponent(document.getElementById('host-name-input').value.trim() || 'Host');
    window.location.href = `/room?code=${generatedCode}&role=host&name=${name}`;
  }
});

// ---- Copy Code ----
document.getElementById('copy-code').addEventListener('click', () => {
  if (!generatedCode) return;
  navigator.clipboard.writeText(generatedCode).then(() => {
    showToast('📋 Code copied to clipboard!');
  }).catch(() => {
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
  const name = document.getElementById('guest-name-input').value.trim();
  if (!name) {
    showToast('Please enter your name first!', 'error');
    document.getElementById('guest-name-input').focus();
    return;
  }
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!code || code.length < 4) {
    showToast('Please enter a valid room code', 'error');
    return;
  }
  window.location.href = `/room?code=${code}&role=guest&name=${encodeURIComponent(name)}`;
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

// =============================================
// 3D Particles Background Animation
// =============================================
const canvas = document.getElementById('particles-bg');
if (canvas) {
  const ctx = canvas.getContext('2d');
  let particles = [];
  const PARTICLE_COUNT = 40;

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  class Particle {
    constructor() {
      this.reset();
    }
    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.z = Math.random() * 3 + 0.5;
      this.radius = (Math.random() * 2.5 + 1) / this.z;
      this.vx = (Math.random() - 0.5) * 0.4;
      this.vy = (Math.random() - 0.5) * 0.4;
      this.alpha = (Math.random() * 0.4 + 0.1) / this.z;
      const colors = ['139,92,246', '6,182,212', '236,72,153', '16,185,129'];
      this.color = colors[Math.floor(Math.random() * colors.length)];
      this.pulseSpeed = Math.random() * 0.02 + 0.005;
      this.pulseOffset = Math.random() * Math.PI * 2;
    }
    update(t) {
      this.x += this.vx;
      this.y += this.vy;
      if (this.x < -10 || this.x > canvas.width + 10 || this.y < -10 || this.y > canvas.height + 10) {
        this.reset();
      }
      this.currentAlpha = this.alpha * (0.5 + 0.5 * Math.sin(t * this.pulseSpeed + this.pulseOffset));
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${this.color},${this.currentAlpha})`;
      ctx.fill();

      // Glow
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius * 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${this.color},${this.currentAlpha * 0.15})`;
      ctx.fill();
    }
  }

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push(new Particle());
  }

  function drawConnections() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          const a = (1 - dist / 150) * 0.08;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(139,92,246,${a})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  let t = 0;
  function animate() {
    t++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.update(t);
      p.draw();
    });
    drawConnections();
    requestAnimationFrame(animate);
  }
  animate();
}
