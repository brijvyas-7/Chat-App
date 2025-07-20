const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { format } = require('winston');
const { userJoin, getCurrentUser, getCurrentUserByUsername, userLeave, getRoomUsers, syncUsers } = require('./utils/users');
const { formatMessage } = require('./utils/messages');
const { addMessage, getMessages } = require('./utils/messageStore');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  transports: ['websocket', 'polling']
});

app.use(express.static('public'));

const logger = winston.createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new DailyRotateFile({
      filename: 'logs/app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d'
    })
  ]
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console());
}

const log = (category, message, data = {}) => {
  const userState = getRoomUsers(data.room || '').map(username => {
    const user = getCurrentUserByUsername(username, data.room);
    return user ? `${username} (socketId: ${user.socketId}, lastActive: ${new Date(user.lastActive).toISOString()}, connected: ${user.connected || false})` : username;
  }).join(', ') || 'No active users';
  logger.info(`[${category}] ${message}`, { ...data, activeUsers: userState, usersArray: users.map(u => ({ username: u.username, socketId: u.socketId, room: u.room, lastActive: new Date(u.lastActive).toISOString(), connected: u.connected || false })) });
};

let activeCalls = {};
const signalingQueue = {};
let users = []; // Ensure users is accessible for logging

const findUserSocket = (username, room) => {
  const socket = Object.values(io.sockets.sockets).find(s => {
    const user = getCurrentUser(s.id);
    log('DEBUG', 'Checking socket for user', { username, room, socketId: s.id, user, connected: s.connected });
    return user?.username === username && user?.room === room && (s.connected || user.lastActive > Date.now() - 120000);
  });
  if (!socket) {
    log('ERROR', 'No socket found for user', { username, room, sockets: Object.keys(io.sockets.sockets) });
  }
  return socket;
};

io.on('connection', socket => {
  log('CONNECTION', `New connection: ${socket.id}`);

  socket.on('joinRoom', ({ username, room }) => {
    if (!username || !room) {
      log('ERROR', 'Invalid joinRoom data', { username, room });
      socket.emit('error', 'Username and room are required');
      return;
    }
    log('DEBUG', 'Before userJoin', { username, room, socketId: socket.id, users: users.length });
    const user = userJoin(socket.id, username, room);
    user.connected = true;
    log('DEBUG', 'After userJoin', { username, room, socketId: socket.id, users: users.length });
    socket.join(user.room);
    socket.emit('message', formatMessage('ChatBot', `Welcome to the room ${room}, ${username}!`));
    socket.broadcast.to(user.room).emit('message', formatMessage('ChatBot', `${username} has joined the chat`));
    io.to(user.room).emit('roomUsers', { room: user.room, users: getRoomUsers(user.room) });
    socket.emit('chatMessages', getMessages(user.room));
    log('ROOM', `${username} joined room ${room}`, { socketId: socket.id });
  });

  socket.on('chatMessage', msg => {
    const user = getCurrentUser(socket.id);
    if (!user) return;
    const message = formatMessage(user.username, msg);
    addMessage(user.room, message);
    io.to(user.room).emit('message', message);
    log('MESSAGE', `Message from ${user.username} in ${user.room}`, { message: msg });
  });

  socket.on('getCallState', () => {
    const user = getCurrentUser(socket.id);
    if (!user) return;
    const yourRooms = Object.keys(socket.rooms).filter(room => room !== socket.id);
    log('CALL', `Call state requested by socket ${socket.id}`, { rooms: yourRooms });
    socket.emit('callState', { activeCalls, yourRooms });
  });

  socket.on('call-initiate', ({ room, callId, callType, caller }) => {
    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) return;
    activeCalls[room] = activeCalls[room] || {};
    activeCalls[room][callId] = { callId, callType, participants: [caller], createdAt: Date.now() };
    socket.to(room).emit('incoming-call', { callType, callId, caller });
    io.to(room).emit('callParticipants', { callId, participants: [caller] });
    log('CALL', `Call initiated by ${caller} in ${room} (${callType})`, { callId });
  });

  socket.on('call-accepted', ({ room, callId }) => {
    const user = getCurrentUser(socket.id);
    if (!user || !activeCalls[room]?.[callId]) return;
    activeCalls[room][callId].participants.push(user.username);
    io.to(room).emit('callParticipants', { callId, participants: activeCalls[room][callId].participants });
    log('CALL', `Call accepted by ${user.username} in ${room}`, { callId });
  });

  socket.on('end-call', ({ room, callId }) => {
    const user = getCurrentUser(socket.id);
    if (!user || !activeCalls[room]?.[callId]) return;
    delete activeCalls[room][callId];
    if (Object.keys(activeCalls[room]).length === 0) delete activeCalls[room];
    io.to(room).emit('call-ended', { callId });
    log('CALL', `Call ${callId} ended in ${room} by ${user.username}`);
  });

  socket.on('offer', ({ target, offer, callId, room }) => {
    const user = getCurrentUser(socket.id);
    if (!user || !callId) return;
    const targetSocket = findUserSocket(target, room);
    if (targetSocket) {
      targetSocket.emit('offer', { offer, callId, caller: user.username });
      log('SIGNALING', `Forwarding offer from ${user.username} to ${target}`, { callId });
    } else {
      signalingQueue[callId] = signalingQueue[callId] || [];
      signalingQueue[callId].push({ type: 'offer', target, data: { offer, caller: user.username }, retryCount: 0, room });
      log('SIGNALING', `Target user ${target} not found in room ${room}, queuing offer`, { callId });
    }
  });

  socket.on('answer', ({ target, answer, callId, room }) => {
    const user = getCurrentUser(socket.id);
    if (!user || !callId) return;
    const targetSocket = findUserSocket(target, room);
    if (targetSocket) {
      targetSocket.emit('answer', { answer, callId, caller: user.username });
      log('SIGNALING', `Forwarding answer from ${user.username} to ${target}`, { callId });
    } else {
      signalingQueue[callId] = signalingQueue[callId] || [];
      signalingQueue[callId].push({ type: 'answer', target, data: { answer, caller: user.username }, retryCount: 0, room });
      log('SIGNALING', `Target user ${target} not found in room ${room}, queuing answer`, { callId });
    }
  });

  socket.on('ice-candidate', ({ target, candidate, callId, room }) => {
    const user = getCurrentUser(socket.id);
    if (!user || !callId) return;
    const targetSocket = findUserSocket(target, room);
    if (targetSocket) {
      targetSocket.emit('ice-candidate', { candidate, callId, caller: user.username });
      log('SIGNALING', `Forwarding ice-candidate from ${user.username} to ${target}`, { callId });
    } else {
      signalingQueue[callId] = signalingQueue[callId] || [];
      signalingQueue[callId].push({ type: 'ice-candidate', target, data: { candidate, caller: user.username }, retryCount: 0, room });
      log('SIGNALING', `Target user ${target} not found in room ${room}, queuing ICE candidate`, { callId });
    }
  });

  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
      io.to(user.room).emit('message', formatMessage('ChatBot', `${user.username} has left the chat`));
      io.to(user.room).emit('roomUsers', { room: user.room, users: getRoomUsers(user.room) });
      Object.keys(activeCalls[user.room] || {}).forEach(callId => {
        const call = activeCalls[user.room][callId];
        if (call.participants.includes(user.username)) {
          call.participants = call.participants.filter(p => p !== user.username);
          io.to(user.room).emit('callParticipants', { callId, participants: call.participants });
          if (call.participants.length === 0) {
            delete activeCalls[user.room][callId];
            io.to(user.room).emit('call-ended', { callId });
          }
        }
      });
      if (activeCalls[user.room] && Object.keys(activeCalls[user.room]).length === 0) {
        delete activeCalls[user.room];
      }
      log('CONNECTION', `${user.username} disconnected`, { socketId: socket.id });
    }
  });
});

setInterval(() => {
  syncUsers(io.sockets.sockets);
  Object.keys(signalingQueue).forEach(callId => {
    signalingQueue[callId] = signalingQueue[callId].filter(item => item.retryCount < 3);
    signalingQueue[callId].forEach(item => {
      const { type, target, data, retryCount, room } = item;
      const targetSocket = findUserSocket(target, room);
      if (targetSocket) {
        targetSocket.emit(type, { ...data, callId });
        signalingQueue[callId] = signalingQueue[callId].filter(i => i !== item);
        log('SIGNALING', `Delivered queued ${type} to ${target}`, { callId, retryCount });
      } else {
        item.retryCount += 1;
        log('SIGNALING', `Retrying ${type} for ${target} (attempt ${item.retryCount})`, { callId });
        if (item.retryCount >= 3) {
          signalingQueue[callId] = signalingQueue[callId].filter(i => i !== item);
          log('SIGNALING', `Failed to deliver ${type} to ${target} after 3 retries`, { callId });
        }
      }
    });
    if (signalingQueue[callId].length === 0) delete signalingQueue[callId];
  });
}, 1000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => log('SERVER', `Server running on port ${PORT}`));