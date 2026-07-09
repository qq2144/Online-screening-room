/* global io */
const $ = (id) => document.getElementById(id);

const socket = io();
let roomId = null;
let selfName = null;
let authPassword = null; // kept in memory only, reused as the upload/delete auth header
let uploadLimits = { maxUploadBytes: null, allowedExtensions: [] };

// Guards against the echo loop: when we apply a remote command it triggers
// the same video events we listen to, which would re-broadcast forever.
let applyingRemote = false;

const video = $('video');

const AUTH_KEY = 'screening-room:auth';

// ---- Persistent login ------------------------------------------------------
function saveAuth(name, room, password) {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ name, room, password }));
  } catch {
    // Storage can be unavailable (private mode, quota); login just won't persist.
  }
}

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearAuth() {
  try { localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
}

function enterApp(name, room, password, state, roster) {
  selfName = name;
  roomId = room;
  authPassword = password;
  $('room-label').textContent = room;
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  renderRoster(roster);
  loadMovieList();
  loadUploadLimits();
  applyState(state);
}

function attemptJoin(name, room, password, { silent } = {}) {
  return new Promise((resolve) => {
    socket.emit('join', { roomId: room, password, name }, (res) => {
      if (!res.ok) {
        if (!silent) $('gate-error').textContent = res.error || '进入失败';
        resolve(false);
        return;
      }
      saveAuth(name, room, password);
      enterApp(name, room, password, res.state, res.roster);
      resolve(true);
    });
  });
}

$('enter').addEventListener('click', () => {
  const name = $('name').value.trim() || '匿名';
  const room = $('room').value.trim() || 'default';
  const password = $('password').value;
  attemptJoin(name, room, password);
});

$('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('enter').click();
});

$('logout-btn').addEventListener('click', () => {
  clearAuth();
  location.reload();
});

// Try to resume a previous session automatically.
(function autoLogin() {
  const saved = loadAuth();
  if (!saved) return;
  $('gate-form').classList.add('hidden');
  $('gate-loading').classList.remove('hidden');
  $('name').value = saved.name;
  $('room').value = saved.room;
  $('password').value = saved.password;

  socket.on('connect', async function onConnect() {
    socket.off('connect', onConnect);
    const ok = await attemptJoin(saved.name, saved.room, saved.password, { silent: true });
    if (!ok) {
      clearAuth();
      $('gate-loading').classList.add('hidden');
      $('gate-form').classList.remove('hidden');
      $('gate-error').textContent = '自动登录失败，请重新输入密码';
    }
  });
})();

// ---- Movie list ------------------------------------------------------------
async function loadMovieList() {
  const res = await fetch('/api/movies');
  const { movies } = await res.json();
  const list = $('movie-list');
  list.innerHTML = '';

  if (!movies.length) {
    const li = document.createElement('li');
    li.className = 'movie-empty';
    li.textContent = '还没有影片，上传一部吧';
    list.appendChild(li);
    return;
  }

  for (const m of movies) {
    const li = document.createElement('li');
    li.className = 'movie-item';
    if (video.dataset.movie === m) li.classList.add('active');

    const name = document.createElement('span');
    name.className = 'movie-name';
    name.textContent = m;
    name.title = m;

    const playBtn = document.createElement('button');
    playBtn.className = 'icon-btn';
    playBtn.type = 'button';
    playBtn.title = '加载并同步给对方';
    playBtn.textContent = '▶';
    playBtn.addEventListener('click', () => loadMovie(m));

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn danger';
    delBtn.type = 'button';
    delBtn.title = '删除影片';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => deleteMovie(m));

    li.append(name, playBtn, delBtn);
    list.appendChild(li);
  }
}

$('refresh-movies').addEventListener('click', () => loadMovieList());

function loadMovie(movie) {
  setMovie(movie);
  // Tell the other side to load the same film from the start.
  socket.emit('control', { type: 'movie', movie, currentTime: 0, isPlaying: false });
}

function deleteMovie(movie) {
  if (!confirm(`确定要删除「${movie}」吗？此操作不可撤销。`)) return;

  const params = new URLSearchParams({ roomId: roomId || '', name: selfName || '' });
  fetch(`/api/movies/${encodeURIComponent(movie)}?${params.toString()}`, {
    method: 'DELETE',
    headers: { 'X-Screening-Password': authPassword || '' },
  })
    .then((r) => r.json())
    .then((res) => {
      if (!res.ok) {
        alert(res.error || '删除失败');
        return;
      }
      loadMovieList();
    })
    .catch(() => alert('网络错误，删除失败'));
}

function setMovie(movie) {
  if (video.dataset.movie === movie) return;
  video.dataset.movie = movie;
  video.src = '/media/' + encodeURIComponent(movie);
  $('overlay').classList.remove('hidden');
  loadMovieList();
}

socket.on('movie-deleted', (msg) => {
  if (video.dataset.movie !== msg.filename) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  delete video.dataset.movie;
  $('overlay').classList.add('hidden');
});

// ---- Upload -----------------------------------------------------------------
async function loadUploadLimits() {
  try {
    const res = await fetch('/api/config');
    uploadLimits = await res.json();
    if (uploadLimits.maxUploadBytes) {
      const gb = Math.floor(uploadLimits.maxUploadBytes / 1024 ** 3);
      $('upload-hint').textContent =
        `支持 ${uploadLimits.allowedExtensions.join(' / ')}，单文件最大 ${gb}GB`;
    }
  } catch {
    // Non-fatal: server-side checks still apply even without client-side hints.
  }
}

function setUploadStatus(text, isError) {
  const el = $('upload-status');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

$('upload-btn').addEventListener('click', () => {
  const input = $('upload-file');
  const file = input.files[0];
  if (!file) {
    setUploadStatus('请先选择一个文件', true);
    return;
  }

  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  if (uploadLimits.allowedExtensions.length && !uploadLimits.allowedExtensions.includes(ext)) {
    setUploadStatus(`不支持的格式，请使用：${uploadLimits.allowedExtensions.join(' / ')}`, true);
    return;
  }
  if (uploadLimits.maxUploadBytes && file.size > uploadLimits.maxUploadBytes) {
    const gb = Math.floor(uploadLimits.maxUploadBytes / 1024 ** 3);
    setUploadStatus(`文件过大，超过 ${gb}GB 限制`, true);
    return;
  }

  const form = new FormData();
  form.append('movie', file);

  const params = new URLSearchParams({ roomId: roomId || '', name: selfName || '' });
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/upload?${params.toString()}`);
  xhr.setRequestHeader('X-Screening-Password', authPassword || '');

  $('upload-btn').disabled = true;
  $('upload-progress-wrap').classList.remove('hidden');
  $('upload-progress-bar').style.width = '0%';
  setUploadStatus('上传中… 0%');

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $('upload-progress-bar').style.width = pct + '%';
    setUploadStatus(`上传中… ${pct}%`);
  });

  xhr.addEventListener('load', () => {
    $('upload-btn').disabled = false;
    let res = null;
    try { res = JSON.parse(xhr.responseText); } catch { /* ignore */ }

    if (xhr.status === 200 && res?.ok) {
      setUploadStatus(`上传成功：${res.filename}`);
      input.value = '';
      loadMovieList();
    } else {
      setUploadStatus(res?.error || `上传失败（${xhr.status}）`, true);
    }
    setTimeout(() => $('upload-progress-wrap').classList.add('hidden'), 1500);
  });

  xhr.addEventListener('error', () => {
    $('upload-btn').disabled = false;
    setUploadStatus('网络错误，上传失败', true);
  });

  xhr.send(form);
});

socket.on('movies-updated', () => loadMovieList());

// ---- Apply incoming state / commands ---------------------------------------
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

// ---- Local video events -> broadcast ---------------------------------------
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

// ---- Autoplay unlock --------------------------------------------------------
$('start-btn').addEventListener('click', () => {
  $('overlay').classList.add('hidden');
  video.play().catch(() => {});
});

// ---- Chat -------------------------------------------------------------------
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

socket.on('system', (msg) => logSystem(msg.text));

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

// ---- Roster (who's watching) ------------------------------------------------
const AVATAR_COLORS = ['#CC785C', '#4C7A6B', '#5B7FA6', '#A6763F', '#8A6DAB'];

function colorFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function renderRoster(list) {
  if (!list) return;
  $('members').textContent = `👥 ${list.length} 人在线`;

  const roster = $('roster');
  roster.innerHTML = '';
  for (const member of list) {
    const chip = document.createElement('div');
    chip.className = 'roster-chip' + (member.id === socket.id ? ' me' : '');

    const avatar = document.createElement('span');
    avatar.className = 'roster-avatar';
    avatar.style.background = colorFor(member.name);
    avatar.textContent = member.name.slice(0, 1).toUpperCase();

    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = member.id === socket.id ? `${member.name}（你）` : member.name;

    chip.append(avatar, name);
    roster.appendChild(chip);
  }
}

socket.on('roster', (list) => renderRoster(list));

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
