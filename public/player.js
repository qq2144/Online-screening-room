/* global io */
const $ = (id) => document.getElementById(id);

const socket = io();
let roomId = null;
let selfName = null;

// Guards against the echo loop: when we apply a remote command it triggers
// the same video events we listen to, which would re-broadcast forever.
let applyingRemote = false;

const video = $('video');

// ---- Login ---------------------------------------------------------------
$('enter').addEventListener('click', () => {
  const name = $('name').value.trim() || '匿名';
  const room = $('room').value.trim() || 'default';
  const password = $('password').value;

  socket.emit('join', { roomId: room, password, name }, (res) => {
    if (!res.ok) {
      $('gate-error').textContent = res.error || '进入失败';
      return;
    }
    selfName = name;
    roomId = room;
    $('room-label').textContent = room;
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    updateMembers(res.members);
    loadMovieList();
    applyState(res.state);
  });
});

$('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('enter').click();
});

// ---- Movie selection -----------------------------------------------------
async function loadMovieList() {
  const res = await fetch('/api/movies');
  const { movies } = await res.json();
  const sel = $('movie-select');
  sel.innerHTML = '';
  if (!movies.length) {
    const opt = document.createElement('option');
    opt.textContent = '（media 目录里还没有影片）';
    sel.appendChild(opt);
    return;
  }
  for (const m of movies) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
}

$('load-movie').addEventListener('click', () => {
  const movie = $('movie-select').value;
  if (!movie) return;
  setMovie(movie);
  // Tell the other side to load the same film from the start.
  socket.emit('control', { type: 'movie', movie, currentTime: 0, isPlaying: false });
});

function setMovie(movie) {
  if (video.dataset.movie === movie) return;
  video.dataset.movie = movie;
  video.src = '/media/' + encodeURIComponent(movie);
  $('overlay').classList.remove('hidden');
}

// ---- Apply incoming state / commands ------------------------------------
function applyState(state) {
  if (!state) return;
  if (state.movie) setMovie(state.movie);
  applyingRemote = true;
  if (typeof state.currentTime === 'number') {
    // Seek once metadata is ready.
    const seek = () => { video.currentTime = state.currentTime; };
    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
  }
  if (state.isPlaying) video.play().catch(() => {});
  else video.pause();
  setTimeout(() => { applyingRemote = false; }, 300);
}

socket.on('control', (msg) => {
  applyingRemote = true;
  switch (msg.type) {
    case 'movie':
      setMovie(msg.movie);
      break;
    case 'play':
      if (Math.abs(video.currentTime - msg.currentTime) > 0.5)
        video.currentTime = msg.currentTime;
      video.play().catch(() => {});
      break;
    case 'pause':
      video.currentTime = msg.currentTime;
      video.pause();
      break;
    case 'seek':
      video.currentTime = msg.currentTime;
      break;
  }
  logSystem(`${msg.by || '对方'} ${labelFor(msg.type)}`);
  setTimeout(() => { applyingRemote = false; }, 300);
});

// Drift-correction heartbeat: gently nudge if we've drifted > 1s.
socket.on('sync', (msg) => {
  if (video.paused) return;
  if (Math.abs(video.currentTime - msg.currentTime) > 1) {
    applyingRemote = true;
    video.currentTime = msg.currentTime;
    setTimeout(() => { applyingRemote = false; }, 300);
  }
});

function labelFor(type) {
  return { play: '播放了', pause: '暂停了', seek: '拖动了进度', movie: '换了影片' }[type] || '';
}

// ---- Local video events -> broadcast ------------------------------------
video.addEventListener('play', () => {
  if (applyingRemote) return;
  socket.emit('control', { type: 'play', currentTime: video.currentTime, isPlaying: true });
});
video.addEventListener('pause', () => {
  if (applyingRemote) return;
  socket.emit('control', { type: 'pause', currentTime: video.currentTime, isPlaying: false });
});
video.addEventListener('seeked', () => {
  if (applyingRemote) return;
  socket.emit('control', { type: 'seek', currentTime: video.currentTime, isPlaying: !video.paused });
});

// Send a heartbeat every 3s while playing so the other side self-corrects.
setInterval(() => {
  if (!roomId || video.paused || applyingRemote) return;
  socket.emit('sync', { currentTime: video.currentTime, isPlaying: true });
}, 3000);

// ---- Autoplay unlock -----------------------------------------------------
$('start-btn').addEventListener('click', () => {
  $('overlay').classList.add('hidden');
  video.play().catch(() => {});
});

// ---- Chat ----------------------------------------------------------------
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat', text);
  input.value = '';
});

socket.on('chat', (msg) => {
  const line = document.createElement('div');
  line.className = 'chat-line' + (msg.name === selfName ? ' me' : '');
  line.innerHTML = `<span class="chat-name">${escapeHtml(msg.name)}</span>${escapeHtml(msg.text)}`;
  appendChat(line);
});

socket.on('system', (msg) => {
  if (msg.members !== undefined) updateMembers(msg.members);
  logSystem(msg.text);
});

function logSystem(text) {
  const line = document.createElement('div');
  line.className = 'chat-sys';
  line.textContent = text;
  appendChat(line);
}

function appendChat(node) {
  const chat = $('chat');
  chat.appendChild(node);
  chat.scrollTop = chat.scrollHeight;
}

function updateMembers(n) {
  if (n !== undefined) $('members').textContent = `👥 ${n} 人在线`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
