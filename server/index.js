import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import {
  getRoom,
  projectedTime,
  updateState,
  removeMember,
  addMember,
  roster,
  allRooms,
  clearMovieIfMatches,
} from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MEDIA_DIR = path.join(ROOT, 'media');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = process.env.PORT || 3000;

// 共享密码必须通过环境变量设置，禁止硬编码默认值
const PASSWORD = process.env.SCREENING_PASSWORD;
if (!PASSWORD || PASSWORD.trim().length === 0) {
  throw new Error(
    '环境变量 SCREENING_PASSWORD 必须设置且不能为空字符串。' +
    '示例: SCREENING_PASSWORD=your-secret-password npm start'
  );
}

const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v', '.mov']);

const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_GB) || 30) * 1024 ** 3;
const UPLOAD_SAFETY_MARGIN_BYTES = 1024 ** 3; // keep 1GB free headroom on disk

const app = express();
const server = http.createServer(app);
const io = new Server(server);

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---- Static assets -------------------------------------------------------
app.use(express.static(PUBLIC_DIR));

// Serve media with HTTP Range support (express.static handles Range headers,
// which is what makes the scrub bar / seeking work).
app.use(
  '/media',
  express.static(MEDIA_DIR, {
    acceptRanges: true,
    // Movies are large; let the browser cache aggressively.
    maxAge: '1h',
  })
);

// List available movies in the media directory.
app.get('/api/movies', (_req, res) => {
  fs.readdir(MEDIA_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'cannot read media dir' });
    const movies = files
      // Dotfiles are in-progress uploads (see upload route below) — never list them.
      .filter((f) => !f.startsWith('.') && VIDEO_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    res.json({ movies });
  });
});

// Upload limits/whitelist, so the client can validate before sending bytes.
app.get('/api/config', (_req, res) => {
  res.json({
    maxUploadBytes: MAX_UPLOAD_BYTES,
    allowedExtensions: [...VIDEO_EXT],
  });
});

// ---- Upload safeguards ----------------------------------------------------
// 1. Shared-password auth (same secret as room join), with a lockout after
//    repeated bad attempts to blunt brute-forcing.
// 2. Extension whitelist (fileFilter) — anything else is rejected before a
//    single byte is written to disk.
// 3. Size cap (multer limits.fileSize), configurable via MAX_UPLOAD_GB.
// 4. Disk free-space check against the declared Content-Length before
//    accepting the body, so a huge upload can't fill the VPS disk.
// 5. Only one upload accepted at a time, to avoid two concurrent transfers
//    thrashing disk I/O or racing on the same filename.
// 6. Uploads land under a dot-prefixed temp name (invisible to /api/movies
//    and to express.static's default dotfile handling) and are atomically
//    renamed to their final, sanitized, de-duplicated name only once fully
//    received; any failure/abort deletes the partial file.
// 7. Filenames are sanitized (basename only) to prevent path traversal.

let uploadAuthFailures = 0;
let uploadAuthLockUntil = 0;

function requireUploadAuth(req, res, next) {
  const now = Date.now();
  if (now < uploadAuthLockUntil) {
    return res.status(429).json({ ok: false, error: '密码尝试次数过多，请 1 分钟后再试' });
  }
  if (req.headers['x-screening-password'] !== PASSWORD) {
    uploadAuthFailures += 1;
    if (uploadAuthFailures >= 10) {
      uploadAuthLockUntil = now + 60_000;
      uploadAuthFailures = 0;
    }
    return res.status(401).json({ ok: false, error: '密码错误' });
  }
  uploadAuthFailures = 0;
  next();
}

function sanitizeBaseName(name) {
  const stripped = path.basename(name).replace(/[/\\]/g, '');
  return stripped || 'movie';
}

function freeSpaceBytes(dir) {
  try {
    const out = execFileSync('df', ['-Pk', dir], { encoding: 'utf8' });
    const dataLine = out.trim().split('\n').pop();
    const availKb = Number(dataLine.trim().split(/\s+/)[3]);
    return Number.isFinite(availKb) ? availKb * 1024 : Infinity;
  } catch {
    // If `df` isn't available (e.g. non-Linux dev machine), don't block uploads.
    return Infinity;
  }
}

let uploadInProgress = false;

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
  filename: (req, _file, cb) => {
    const tempName = `.upload-${Date.now()}-${Math.random().toString(36).slice(2)}.part`;
    req.__tempUploadName = tempName;
    cb(null, tempName);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!VIDEO_EXT.has(ext)) {
      cb(new Error('UNSUPPORTED_TYPE'));
      return;
    }
    cb(null, true);
  },
});

app.post('/api/upload', requireUploadAuth, (req, res) => {
  if (uploadInProgress) {
    return res.status(409).json({ ok: false, error: '已有上传正在进行，请稍后再试' });
  }

  const declaredSize = Number(req.headers['content-length'] || 0);
  const free = freeSpaceBytes(MEDIA_DIR);
  if (declaredSize > 0 && free < declaredSize + UPLOAD_SAFETY_MARGIN_BYTES) {
    return res.status(413).json({ ok: false, error: '服务器磁盘空间不足，无法接收该文件' });
  }

  uploadInProgress = true;
  upload.single('movie')(req, res, (err) => {
    uploadInProgress = false;
    const tempPath = req.__tempUploadName ? path.join(MEDIA_DIR, req.__tempUploadName) : null;

    if (err) {
      if (tempPath) fs.unlink(tempPath, () => {});
      let message = '上传失败';
      if (err.message === 'UNSUPPORTED_TYPE') {
        message = `不支持的文件格式，仅支持 ${[...VIDEO_EXT].join('/')}`;
      } else if (err.code === 'LIMIT_FILE_SIZE') {
        message = `文件超过大小限制（${Math.floor(MAX_UPLOAD_BYTES / 1024 ** 3)}GB）`;
      }
      return res.status(400).json({ ok: false, error: message });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: '没有收到文件' });
    }

    const originalBase = sanitizeBaseName(req.file.originalname);
    const ext = path.extname(originalBase).toLowerCase();
    const stem = path.basename(originalBase, ext) || 'movie';

    let finalName = `${stem}${ext}`;
    let counter = 1;
    while (fs.existsSync(path.join(MEDIA_DIR, finalName))) {
      finalName = `${stem} (${counter})${ext}`;
      counter += 1;
    }
    fs.renameSync(req.file.path, path.join(MEDIA_DIR, finalName));

    const roomId = (req.query.roomId || '').toString();
    const uploaderName = (req.query.name || '有人').toString().slice(0, 24);
    if (roomId) {
      io.to(roomId).emit('movies-updated', { filename: finalName });
      io.to(roomId).emit('system', { text: `${uploaderName} 上传了新影片：${finalName}` });
    }

    res.json({ ok: true, filename: finalName });
  });
});

// Delete a movie from the media directory. Shares the same password auth
// (and brute-force lockout) as uploads, since both mutate shared storage.
app.delete('/api/movies/:filename', requireUploadAuth, (req, res) => {
  const name = sanitizeBaseName(req.params.filename);
  const target = path.join(MEDIA_DIR, name);

  // Defense in depth: the sanitized name should never resolve outside
  // MEDIA_DIR, but double-check before touching the filesystem.
  if (path.dirname(target) !== MEDIA_DIR) {
    return res.status(400).json({ ok: false, error: '非法文件名' });
  }
  if (!fs.existsSync(target)) {
    return res.status(404).json({ ok: false, error: '文件不存在' });
  }

  fs.unlinkSync(target);

  // If any room was actively pointing at this movie, clear it so no one is
  // left staring at a dead video src.
  for (const room of allRooms()) {
    if (clearMovieIfMatches(room, name)) {
      io.to(room.id).emit('movie-deleted', { filename: name });
    }
  }

  const roomId = (req.query.roomId || '').toString();
  const actorName = (req.query.name || '有人').toString().slice(0, 24);
  if (roomId) {
    io.to(roomId).emit('movies-updated');
    io.to(roomId).emit('system', { text: `${actorName} 删除了影片：${name}` });
  }

  res.json({ ok: true });
});

// ---- Realtime sync -------------------------------------------------------
io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join', ({ roomId, password, name }, ack) => {
    if (password !== PASSWORD) {
      ack?.({ ok: false, error: '密码错误' });
      return;
    }
    roomId = (roomId || 'default').trim() || 'default';
    joinedRoom = roomId;
    socket.data.name = (name || '匿名').slice(0, 24);

    const room = getRoom(roomId);
    addMember(room, socket.id, socket.data.name);
    socket.join(roomId);

    // Send the newcomer the current playback state so they land in sync.
    ack?.({
      ok: true,
      state: {
        movie: room.movie,
        isPlaying: room.isPlaying,
        currentTime: projectedTime(room),
      },
      roster: roster(room),
    });

    io.to(roomId).emit('system', { text: `${socket.data.name} 进入了房间` });
    io.to(roomId).emit('roster', roster(room));
  });

  // Playback control from one client -> broadcast to the other.
  socket.on('control', (payload) => {
    if (!joinedRoom) return;
    const room = getRoom(joinedRoom);
    updateState(room, payload);
    // Relay to everyone else in the room (not the sender).
    socket.to(joinedRoom).emit('control', {
      ...payload,
      by: socket.data.name,
    });
  });

  // Periodic drift-correction heartbeat from whoever is driving.
  socket.on('sync', (payload) => {
    if (!joinedRoom) return;
    const room = getRoom(joinedRoom);
    updateState(room, payload);
    socket.to(joinedRoom).emit('sync', payload);
  });

  socket.on('chat', (text) => {
    if (!joinedRoom || typeof text !== 'string') return;
    io.to(joinedRoom).emit('chat', {
      name: socket.data.name,
      text: text.slice(0, 500),
      ts: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = removeMember(joinedRoom, socket.id);
    io.to(joinedRoom).emit('system', {
      text: `${socket.data.name || '有人'} 离开了房间`,
    });
    if (room) io.to(joinedRoom).emit('roster', roster(room));
  });
});

server.listen(PORT, () => {
  console.log(`Screening room running on http://0.0.0.0:${PORT}`);
  console.log(`Media directory: ${MEDIA_DIR}`);
});
