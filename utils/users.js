const users = [];

function userJoin(id, username, room) {
  const user = { id, username, room, socketId: id, lastActive: Date.now(), connected: true };
  const existingIndex = users.findIndex(u => u.username === username && u.room === room);
  if (existingIndex !== -1) {
    console.log(`[USER] Updating existing user: ${username} in room ${room}, new socketId: ${id}`);
    users[existingIndex] = user;
  } else {
    console.log(`[USER] Adding new user: ${username} in room ${room}, socketId: ${id}`);
    users.push(user);
  }
  return user;
}

function getCurrentUser(id) {
  const user = users.find(user => user.socketId === id);
  if (user) user.lastActive = Date.now();
  return user;
}

function getCurrentUserByUsername(username, room) {
  const user = users.find(user => user.username === username && user.room === room);
  if (user) user.lastActive = Date.now();
  return user;
}

function userLeave(id) {
  const index = users.findIndex(user => user.socketId === id);
  if (index !== -1) {
    const user = users.splice(index, 1)[0];
    console.log(`[USER] Removed user: ${user.username}, socketId: ${id}`);
    return user;
  }
}

function getRoomUsers(room) {
  return users.filter(user => user.room === room && user.lastActive > Date.now() - 120000).map(user => user.username);
}

function syncUsers(sockets) {
  const removedUsers = [];
  users.forEach((user, index) => {
    const socket = sockets.get(user.socketId);
    if (!socket || !socket.connected) {
      user.connected = false;
      if (user.lastActive < Date.now() - 120000) {
        removedUsers.push(user);
        users.splice(index, 1);
      }
    } else {
      user.connected = true;
      user.lastActive = Date.now();
    }
  });
  if (removedUsers.length > 0) {
    console.log(`[USER] Sync removed users: ${removedUsers.map(u => u.username).join(', ')}`);
  }
}

module.exports = { userJoin, getCurrentUser, getCurrentUserByUsername, userLeave, getRoomUsers, syncUsers };