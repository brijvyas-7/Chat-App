const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const formatMessage = require('./utils/messages');
const { userJoin, getCurrentUser, userLeave, getRoomUsers, syncUsers, getCurrentUserByUsername } = require('./utils/users');
const messageStore = require('./utils/messageStore');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: 'logs/app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d'
    })
  ]
});

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

const botName = 'ChatApp Bot';
const activeCalls = {};
const signalingQueue = {};
const cleanupLock = new Set();
const callEndDebounce = new Map();

const log = (category, message, data = {}) => {
  const room = data.room || '';
  const users = getRoomUsers(room);
  const userState = users.map(user => `${user.username} (${user.socketId}, lastActive: ${new Date(user.lastActive).toISOString()})`).join(', ') || 'none';
  logger.info(`[${category}] ${message}`, { ...data, activeUsers: userState, userCount: users.length });
};

const findUserSocket = (username, room) => {
  const user = getCurrentUserByUsername(username, room);
  if (!user) {
    log('ERROR', `User ${username} not found in room ${room}`, { room });
    return null;
  }
  const socket = io.sockets.sockets.get(user.id);
  if (!socket || !socket.connected) {
    log('ERROR', `Socket for user ${username} not connected`, { room, socketId: user.id });
    return null;
  }
  return socket;
};

const queueSignalingMessage = (event, data, retryCount = 0) => {
  const { room, callId, targetUser } = data;
  if (!callId) {
    log('ERROR', `Invalid callId in ${event} queue attempt`, { targetUser, room });
    return;
  }
  signalingQueue[room] = signalingQueue[room] || {};
  signalingQueue[room][callId] = signalingQueue[room][callId] || [];
  signalingQueue[room][callId].push({ event, data, retryCount, timestamp: Date.now() });
  log('SIGNALING', `Queued ${event} for ${targetUser} in call ${callId} (room: ${room})`, { retryCount, queueSize: signalingQueue[room][callId].length });
};

const processSignalingQueue = () => {
  Object.entries(signalingQueue).forEach(([room, calls]) => {
    Object.entries(calls).forEach(([callId, messages]) => {
      const call = activeCalls[room]?.[callId];
      if (!call) {
        log('SIGNALING', `Call ${callId} not found, clearing queue`, { room });
        delete signalingQueue[room][callId];
        return;
      }
      // Remove stale messages (older than 30 seconds)
      const now = Date.now();
      messages = messages.filter(msg => now - msg.data.timestamp <= 30000);
      signalingQueue[room][callId] = messages;

      messages.forEach(({ event, data, retryCount }, index) => {
        if (retryCount >= 5) {
          log('SIGNALING', `Failed to deliver ${event} to ${data.targetUser} after ${retryCount} retries`, { callId });
          const senderSocket = findUserSocket(data.userId, room);
          if (senderSocket) {
            senderSocket.emit('error', { code: 'DELIVERY_FAILED', message: `Failed to reach ${data.targetUser}` });
            if (event === 'offer') {
              io.to(room).emit('call-ended', { callId });
              cleanupCall(room, callId);
            }
          }
          messages.splice(index, 1);
          return;
        }

        const targetSocket = findUserSocket(data.targetUser, room);
        if (targetSocket && call.participants.includes(data.targetUser)) {
          targetSocket.emit(event, data);
          log('SIGNALING', `Delivered queued ${event} to ${data.targetUser}`, { callId });
          messages.splice(index, 1);
        } else {
          log('SIGNALING', `Retrying ${event} for ${data.targetUser} (attempt ${retryCount + 1})`, { callId });
          messages[index].retryCount = retryCount + 1;
        }
      });
      if (messages.length === 0) {
        delete signalingQueue[room][callId];
      }
    });
    if (Object.keys(calls).length === 0) {
      delete signalingQueue[room];
    }
  });
};

const broadcastCallParticipants = (room, callId) => {
  const call = activeCalls[room]?.[callId];
  if (!call) return;
  io.to(room).emit('call-participants', {
    callId,
    participants: call.participants
  });
  log('CALL', `Broadcasted participants for call ${callId} in room ${room}`, { participants: call.participants });
};

const cleanupCall = (room, callId) => {
  if (cleanupLock.has(callId)) return;
  cleanupLock.add(callId);
  try {
    if (activeCalls[room]?.[callId]) {
      log('CALL', `Cleaning up call ${callId} in room ${room}`);
      delete activeCalls[room][callId];
      delete signalingQueue[room]?.[callId];
      if (Object.keys(activeCalls[room]).length === 0) {
        delete activeCalls[room];
      }
    }
  } finally {
    cleanupLock.delete(callId);
  }
};

setInterval(() => {
  syncUsers(io.sockets.sockets);
  processSignalingQueue();
}, 500);

io.on('connection', (socket) => {
  log('CONNECTION', `New connection: ${socket.id}`);

  socket.on('check-user-presence', ({ room, userId }, callback) => {
    const user = getCurrentUserByUsername(userId, room);
    const isPresent = !!user && io.sockets.sockets.get(user.id)?.connected;
    log('PRESENCE', `Checked presence for ${userId} in ${room}: ${isPresent}`, { user });
    callback({ isPresent });
  });

  socket.on('joinRoom', ({ username, room }) => {
    if (!username || !room) {
      log('ERROR', 'Invalid joinRoom data', { username, room });
      socket.emit('error', { code: 'INVALID_DATA', message: 'Username and room are required' });
      return;
    }

    const user = userJoin(socket.id, username, room);
    socket.join(user.room);

    log('ROOM', `${username} joined room ${room}`, { socketId: socket.id });

    const welcomeMsg = formatMessage(botName, 'Welcome to ChatApp!');
    messageStore.addMessage(room, welcomeMsg);
    socket.emit('message', welcomeMsg);

    const joinMsg = formatMessage(botName, `${user.username} has joined the chat`);
    messageStore.addMessage(room, joinMsg);
    socket.broadcast.to(user.room).emit('message', joinMsg);

    io.to(user.room).emit('roomUsers', {
      room: user.room,
      users: getRoomUsers(user.room)
    });

    socket.emit('callState', {
      activeCalls,
      yourRooms: Array.from(socket.rooms)
    });
  });

  socket.on('chatMessage', ({ text, replyTo, room, time }) => {
    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) {
      log('ERROR', 'User not in room for chatMessage', { socketId: socket.id, room });
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'You must join a room first' });
      return;
    }

    if (replyTo && (!replyTo.id || !replyTo.username || !replyTo.text)) {
      log('ERROR', 'Invalid replyTo data', { socketId: socket.id, replyTo });
      socket.emit('error', { code: 'INVALID_REPLY_TO', message: 'Invalid reply-to data' });
      return;
    }

    const msg = formatMessage(user.username, text, time, replyTo);
    messageStore.addMessage(room, msg);
    io.to(room).emit('message', msg);
    log('MESSAGE', `Message sent in ${room} by ${user.username}`, { text, replyTo });
  });

  socket.on('call-initiate', ({ room, callId, callType, caller }) => {
    if (!room || !callId || !callType || !caller) {
      log('ERROR', 'Invalid call-initiate data', { room, callId, callType, caller });
      socket.emit('error', { code: 'INVALID_DATA', message: 'Missing required call parameters' });
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.username !== caller || user.room !== room) {
      log('ERROR', 'Unauthorized call initiation', { socketId: socket.id, caller, room });
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Unauthorized call initiation' });
      return;
    }

    activeCalls[room] = activeCalls[room] || {};
    activeCalls[room][callId] = {
      callId,
      callType,
      participants: [caller],
      offers: {},
      answers: {},
      iceCandidates: {},
      timestamp: Date.now()
    };

    log('CALL', `Call initiated by ${caller} in ${room} (${callType})`, { callId });

    Object.keys(activeCalls[room]).forEach(id => {
      if (id !== callId && Date.now() - activeCalls[room][id].timestamp > 3600000) {
        cleanupCall(room, id);
      }
    });

    socket.to(room).emit('incoming-call', {
      callId,
      callType,
      caller
    });

    broadcastCallParticipants(room, callId);
  });

  socket.on('call-accepted', ({ room, callId }) => {
    if (!callId) {
      log('ERROR', 'Invalid callId in call-accepted', { room, socketId: socket.id });
      socket.emit('error', { code: 'INVALID_CALL_ID', message: 'Invalid call ID' });
      return;
    }

    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Call ${callId} not found in room ${room}`);
      socket.emit('error', { code: 'CALL_NOT_FOUND', message: `Call ${callId} not found` });
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) {
      log('ERROR', 'User not identified for call-accepted', { socketId: socket.id });
      socket.emit('error', { code: 'USER_NOT_FOUND', message: 'User not identified' });
      return;
    }

    if (!call.participants.includes(user.username)) {
      call.participants.push(user.username);
    }

    log('CALL', `Call accepted by ${user.username} in ${room}`, { callId });

    io.to(room).emit('user-joined-call', {
      userId: user.username,
      callId
    });

    broadcastCallParticipants(room, callId);

    const callerSocket = findUserSocket(call.participants[0], room);
    if (callerSocket) {
      callerSocket.emit('call-accepted', {
        callId,
        userId: user.username
      });
    }
  });

  socket.on('offer', ({ offer, room, callId, targetUser, userId }) => {
    if (!callId || !userId || userId === targetUser) {
      log('ERROR', 'Invalid callId, userId, or self-directed offer', { room, targetUser, userId });
      socket.emit('error', { code: 'INVALID_OFFER', message: 'Invalid or self-directed offer' });
      return;
    }

    const call = activeCalls[room]?.[callId];
    if (!call || !call.participants.includes(targetUser)) {
      log('ERROR', `Offer for non-existent call ${callId} or target ${targetUser} not in call`);
      socket.emit('error', { code: 'CALL_NOT_FOUND', message: `Call ${callId} or user ${targetUser} not found` });
      return;
    }

    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      log('ERROR', `Unauthorized offer from ${sender?.username || 'unknown'}`, { socketId: socket.id });
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Unauthorized offer' });
      return;
    }

    const targetSocket = findUserSocket(targetUser, room);
    if (targetSocket) {
      log('SIGNALING', `Forwarding offer from ${sender.username} to ${targetUser}`, { callId });
      targetSocket.emit('offer', {
        offer,
        callId,
        userId: sender.username
      });
    } else {
      log('SIGNALING', `Target user ${targetUser} not found in room ${room}, queuing offer`, { callId });
      queueSignalingMessage('offer', { offer, callId, userId: sender.username, targetUser, room, timestamp: Date.now() });
    }
  });

  socket.on('answer', ({ answer, room, callId, targetUser, userId }) => {
    if (!callId || !userId || userId === targetUser) {
      log('ERROR', 'Invalid callId, userId, or self-directed answer', { room, targetUser, userId });
      socket.emit('error', { code: 'INVALID_ANSWER', message: 'Invalid or self-directed answer' });
      return;
    }

    const call = activeCalls[room]?.[callId];
    if (!call || !call.participants.includes(targetUser)) {
      log('ERROR', `Answer for non-existent call ${callId} or target ${targetUser} not in call`);
      socket.emit('error', { code: 'CALL_NOT_FOUND', message: `Call ${callId} or user ${targetUser} not found` });
      return;
    }

    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      log('ERROR', `Unauthorized answer from ${sender?.username || 'unknown'}`, { socketId: socket.id });
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Unauthorized answer' });
      return;
    }

    const targetSocket = findUserSocket(targetUser, room);
    if (targetSocket) {
      log('SIGNALING', `Forwarding answer from ${sender.username} to ${targetUser}`, { callId });
      targetSocket.emit('answer', {
        answer,
        callId,
        userId: sender.username
      });
    } else {
      log('SIGNALING', `Target user ${targetUser} not found in room ${room}, queuing answer`, { callId });
      queueSignalingMessage('answer', { answer, callId, userId: sender.username, targetUser, room, timestamp: Date.now() });
    }
  });

  socket.on('ice-candidate', ({ candidate, room, callId, targetUser, userId }) => {
    if (!callId || !userId || userId === targetUser) {
      log('ERROR', 'Invalid callId, userId, or self-directed ice-candidate', { room, targetUser, userId });
      socket.emit('error', { code: 'INVALID_ICE_CANDIDATE', message: 'Invalid or self-directed ICE candidate' });
      return;
    }

    const call = activeCalls[room]?.[callId];
    if (!call || !call.participants.includes(targetUser)) {
      log('ERROR', `ICE candidate for non-existent call ${callId} or target ${targetUser} not in call`);
      socket.emit('error', { code: 'CALL_NOT_FOUND', message: `Call ${callId} or user ${targetUser} not found` });
      return;
    }

    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      log('ERROR', `Unauthorized ICE candidate from ${sender?.username || 'unknown'}`, { socketId: socket.id });
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Unauthorized ICE candidate' });
      return;
    }

    const targetSocket = findUserSocket(targetUser, room);
    if (targetSocket) {
      log('SIGNALING', `Forwarding ICE candidate from ${sender.username} to ${targetUser}`, { callId });
      targetSocket.emit('ice-candidate', {
        candidate,
        callId,
        userId: sender.username
      });
    } else {
      log('SIGNALING', `Target user ${targetUser} not found in room ${room}, queuing ICE candidate`, { callId });
      queueSignalingMessage('ice-candidate', { candidate, callId, userId: sender.username, targetUser, room, timestamp: Date.now() });
    }
  });

  socket.on('reject-call', ({ room, callId, reason }) => {
    if (!callId) {
      log('ERROR', 'Invalid callId in reject-call', { room, socketId: socket.id });
      socket.emit('error', { code: 'INVALID_CALL_ID', message: 'Invalid call ID' });
      return;
    }

    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Reject call for non-existent call ${callId}`, { room });
      socket.emit('error', { code: 'CALL_NOT_FOUND', message: `Call ${callId} not found` });
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) {
      log('ERROR', 'User not identified for reject-call', { socketId: socket.id });
      socket.emit('error', { code: 'USER_NOT_FOUND', message: 'User not identified' });
      return;
    }

    log('CALL', `Call ${callId} rejected by ${user.username} in ${room}`, { reason });

    io.to(room).emit('reject-call', {
      callId,
      userId: user.username,
      reason
    });

    cleanupCall(room, callId);
  });

  socket.on('end-call', ({ room, callId }) => {
    if (!callId) {
      log('ERROR', 'Invalid callId in end-call', { room, socketId: socket.id });
      socket.emit('error', { code: 'INVALID_CALL_ID', message: 'Invalid call ID' });
      return;
    }

    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Call ${callId} not found in room ${room}`);
      socket.emit('error', { code: 'CALL_NOT_FOUND', message: `Call ${callId} not found` });
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) {
      log('ERROR', 'User not identified for end-call', { socketId: socket.id });
      socket.emit('error', { code: 'USER_NOT_FOUND', message: 'User not identified' });
      return;
    }

    if (callEndDebounce.has(callId)) {
      log('CALL', `Debouncing end-call for ${callId} by ${user.username}`);
      return;
    }

    callEndDebounce.set(callId, setTimeout(() => {
      log('CALL', `Call ${callId} ended by ${user.username} in ${room}`);
      io.to(room).emit('call-ended', { callId });
      cleanupCall(room, callId);
      callEndDebounce.delete(callId);
    }, 500)); // Reduced debounce timeout to 500ms
  });

  socket.on('get-call-participants', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Call ${callId} not found for get-call-participants`, { room });
      socket.emit('error', { code: 'CALL_NOT_FOUND', message: `Call ${callId} not found` });
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) {
      log('ERROR', 'User not identified for get-call-participants', { socketId: socket.id });
      socket.emit('error', { code: 'USER_NOT_FOUND', message: 'User not identified' });
      return;
    }

    log('CALL', `Sending participants for call ${callId} to ${user.username}`, { participants: call.participants });
    socket.emit('call-participants', {
      callId,
      participants: call.participants
    });
  });

  socket.on('mute-state', ({ room, callId, isAudioMuted, userId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Call ${callId} not found for mute-state`, { room });
      socket.emit('error', { code: 'CALL_NOT_FOUND', message: `Call ${callId} not found` });
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.username !== userId || user.room !== room) {
      log('ERROR', 'Unauthorized mute-state update', { socketId: socket.id, userId });
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Unauthorized mute state update' });
      return;
    }

    log('CALL', `Mute state update from ${userId}: ${isAudioMuted}`, { callId });
    socket.to(room).emit('mute-state', { userId, isAudioMuted });
  });

  socket.on('video-state', ({ room, callId, isVideoOff, userId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Call ${callId} not found for video-state`, { room });
      socket.emit('error', { code: 'CALL_NOT_FOUND', message: `Call ${callId} not found` });
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.username !== userId || user.room !== room) {
      log('ERROR', 'Unauthorized video-state update', { socketId: socket.id, userId });
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Unauthorized video state update' });
      return;
    }

    log('CALL', `Video state update from ${userId}: ${isVideoOff}`, { callId });
    socket.to(room).emit('video-state', { userId, isVideoOff });
  });

  socket.on('typing', ({ username, room }) => {
    const user = getCurrentUser(socket.id);
    if (!user || user.username !== username || user.room !== room) {
      log('ERROR', 'Unauthorized typing event', { socketId: socket.id, username });
      return;
    }
    socket.to(room).emit('typing', { username });
  });

  socket.on('stopTyping', ({ username, room }) => {
    const user = getCurrentUser(socket.id);
    if (!user || user.username !== username || user.room !== room) {
      log('ERROR', 'Unauthorized stopTyping event', { socketId: socket.id, username });
      return;
    }
    socket.to(room).emit('stopTyping');
  });

  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
      log('CONNECTION', `${user.username} disconnected`, { socketId: socket.id });

      const leaveMsg = formatMessage(botName, `${user.username} has left the chat`);
      messageStore.addMessage(user.room, leaveMsg);
      io.to(user.room).emit('message', leaveMsg);

      io.to(user.room).emit('roomUsers', {
        room: user.room,
        users: getRoomUsers(user.room)
      });

      Object.entries(activeCalls[user.room] || {}).forEach(([callId, call]) => {
        if (call.participants.includes(user.username)) {
          call.participants = call.participants.filter(u => u !== user.username);
          log('CALL', `${user.username} left call ${callId} in ${user.room}`);
          io.to(user.room).emit('user-left-call', {
            userId: user.username,
            callId
          });
          if (call.participants.length === 0) {
            io.to(user.room).emit('call-ended', { callId });
            cleanupCall(user.room, callId);
          } else {
            broadcastCallParticipants(user.room, callId);
          }
        }
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log('SERVER', `Server running on port ${PORT}`));
