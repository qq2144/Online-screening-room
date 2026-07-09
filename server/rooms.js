// In-memory room state. For a two-person screening room this is plenty;
// nothing needs to survive a server restart.

const rooms = new Map();

function createRoom(roomId) {
  const room = {
    id: roomId,
    movie: null,        // currently selected movie filename
    isPlaying: false,
    currentTime: 0,     // playback position (seconds) at lastUpdate
    lastUpdate: Date.now(),
    members: new Set(), // socket ids
  };
  rooms.set(roomId, room);
  return room;
}

export function getRoom(roomId) {
  return rooms.get(roomId) || createRoom(roomId);
}

// Estimate the "live" playback position, accounting for time elapsed
// since the last control event while the video was playing.
export function projectedTime(room) {
  if (!room.isPlaying) return room.currentTime;
  const elapsed = (Date.now() - room.lastUpdate) / 1000;
  return room.currentTime + elapsed;
}

export function updateState(room, { movie, isPlaying, currentTime }) {
  if (movie !== undefined) room.movie = movie;
  if (isPlaying !== undefined) room.isPlaying = isPlaying;
  if (currentTime !== undefined) room.currentTime = currentTime;
  room.lastUpdate = Date.now();
}

export function removeMember(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.members.delete(socketId);
  if (room.members.size === 0) rooms.delete(roomId);
}
