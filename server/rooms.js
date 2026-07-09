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
    members: new Map(), // socket id -> display name
  };
  rooms.set(roomId, room);
  return room;
}

export function getRoom(roomId) {
  return rooms.get(roomId) || createRoom(roomId);
}

export function allRooms() {
  return [...rooms.values()];
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

// Clears a room's movie if it matches the given filename — used when a
// movie is deleted from disk so no one is left pointing at a dead file.
export function clearMovieIfMatches(room, filename) {
  if (room.movie !== filename) return false;
  room.movie = null;
  room.isPlaying = false;
  room.currentTime = 0;
  room.lastUpdate = Date.now();
  return true;
}

export function addMember(room, socketId, name) {
  room.members.set(socketId, name);
}

export function roster(room) {
  return [...room.members.entries()].map(([id, name]) => ({ id, name }));
}

// Removes a member and returns the room if it still has members afterwards,
// or null if the room is now empty (and has been deleted).
export function removeMember(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.members.delete(socketId);
  if (room.members.size === 0) {
    rooms.delete(roomId);
    return null;
  }
  return room;
}
