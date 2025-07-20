const users = new Map();

function userJoin(id, username, room) {
    const user = { id, username, room, lastActive: Date.now() };
    users.set(id, user);
    return user;
}

function getCurrentUser(id) {
    return users.get(id);
}

function getCurrentUserByUsername(username, room) {
    for (const user of users.values()) {
        if (user.username === username && user.room === room) {
            return user;
        }
    }
    return null;
}

function userLeave(id) {
    const user = users.get(id);
    if (user) {
        users.delete(id);
        return user;
    }
    return null;
}

function getRoomUsers(room) {
    const roomUsers = [];
    for (const user of users.values()) {
        if (user.room === room) {
            roomUsers.push({ username: user.username, socketId: user.id, lastActive: user.lastActive });
        }
    }
    return roomUsers;
}

function syncUsers(sockets) {
    const now = Date.now();
    for (const [id, user] of users) {
        const socket = sockets.get(id);
        if (!socket || !socket.connected || now - user.lastActive > 120000) {
            users.delete(id);
        } else {
            user.lastActive = now;
        }
    }
}

module.exports = {
    userJoin,
    getCurrentUser,
    getCurrentUserByUsername,
    userLeave,
    getRoomUsers,
    syncUsers
};