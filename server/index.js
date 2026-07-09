import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { getRoom, projectedTime, updateState, removeMember } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MEDIA_DIR = path.join(ROOT, 'media');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = process.env.PORT || 3000;
// Shared password for entering a room. Change this before going live.
const PASSWORD = process.env.SCREENING_PASSWORD || 'love';

const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v', '.mov']);

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
      .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    res.json({ movies });
  });
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
    room.members.add(socket.id);
    socket.join(roomId);

    // Send the newcomer the current playback state so they land in sync.
    ack?.({
      ok: true,
      state: {
        movie: room.movie,
        isPlaying: room.isPlaying,
        currentTime: projectedTime(room),
      },
      members: room.members.size,
    });

    io.to(roomId).emit('system', {
      text: `${socket.data.name} 进入了房间`,
      members: room.members.size,
    });
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
    removeMember(joinedRoom, socket.id);
    io.to(joinedRoom).emit('system', {
      text: `${socket.data.name || '有人'} 离开了房间`,
    });
  });
});

server.listen(PORT, () => {
  console.log(`Screening room running on http://0.0.0.0:${PORT}`);
  console.log(`Media directory: ${MEDIA_DIR}`);
});
