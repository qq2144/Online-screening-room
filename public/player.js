/* global io */
const $ = (id) => document.getElementById(id);

const socket = io();
let roomId = null;
let selfName = null;
let authPassword = null; // kept in memory only, reused as the upload auth header
let uploadLimits = { maxUploadBytes: null, allowedExtensions: [] };

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
    authPassword = password;
    $('room-label').textContent = room;
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    updateMembers(res.members);
    loadMovieList();
    loadUploadLimits();
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

// ---- Upload ---------------------------------------------------------------
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
