const users = [];

function userJoin(id, username, room) {
  const user = { id, username, room, socketId: id, lastActive: Date.now() };
  const existingIndex = users.findIndex(u => u.username === username && u.room === room);
  if (existingIndex !== -1) {
    users[existingIndex] = user; // Update existing user
  } else {
    users.push(user);
  }
  return user;
}

function getCurrentUser(id) {
  return users.find(user => user.socketId === id && user.lastActive > Date.now() - 60000);
}

function userLeave(id) {
  const index = users.findIndex(user => user.socketId === id);
  if (index !== -1) {
    return users.splice(index, 1)[0];
  }
}

function getRoomUsers(room) {
  return users.filter(user => user.room === room && user.lastActive > Date.now() - 60000).map(user => user.username);
}

function syncUsers(sockets) {
  users.forEach((user, index) => {
    const socket = sockets.get(user.socketId);
    if (!socket || !socket.connected) {
      users.splice(index, 1);
    } else {
      user.lastActive = Date.now();
    }
  });
}

module.exports = {
  userJoin,
  getCurrentUser,
  userLeave,
  getRoomUsers,
  syncUsers
};