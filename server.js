const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const formatMessage = require('./utils/messages');
const { userJoin, getCurrentUser, userLeave, getRoomUsers } = require('./utils/users');
const messageStore = require('./utils/messageStore');

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

// Handle favicon.ico requests to avoid 404 errors
app.get('/favicon.ico', (req, res) => res.status(204).end());

const botName = 'ChatApp Bot';
const activeCalls = {};
const signalingQueue = {};

// Enhanced logging with timestamps
const log = (category, message, data = {}) => {
  console.log(`[${new Date().toISOString()}] [${category}] ${message}`, data);
};

// Utility function to find user socket by username and room
const findUserSocket = (username, room) => {
  return Object.values(io.sockets.sockets).find(
    s => {
      const user = getCurrentUser(s.id);
      return user?.username === username && user?.room === room && s.connected;
    }
  );
};

// Queue signaling messages for retry
const queueSignalingMessage = (event, data, retryCount = 0) => {
  const { room, callId, targetUser } = data;
  signalingQueue[room] = signalingQueue[room] || {};
  signalingQueue[room][callId] = signalingQueue[room][callId] || [];
  signalingQueue[room][callId].push({ event, data, retryCount, timestamp: Date.now() });
  log('SIGNALING', `Queued ${event} for ${targetUser} in call ${callId} (room: ${room})`, { retryCount });
};

// Process queued signaling messages
const processSignalingQueue = () => {
  Object.entries(signalingQueue).forEach(([room, calls]) => {
    Object.entries(calls).forEach(([callId, messages]) => {
      messages.forEach(({ event, data, retryCount }, index) => {
        if (retryCount >= 3 || Date.now() - data.timestamp > 10000) {
          log('SIGNALING', `Failed to deliver ${event} to ${data.targetUser} after ${retryCount} retries`, { callId });
          const senderSocket = findUserSocket(data.userId, room);
          if (senderSocket) {
            senderSocket.emit('error', `Failed to reach ${data.targetUser}`);
          }
          messages.splice(index, 1);
          return;
        }

        const targetSocket = findUserSocket(data.targetUser, room);
        if (targetSocket) {
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

// Broadcast call participants to all clients in the room
const broadcastCallParticipants = (room, callId) => {
  const call = activeCalls[room]?.[callId];
  if (!call) return;
  io.to(room).emit('call-participants', {
    callId,
    participants: call.participants
  });
  log('CALL', `Broadcasted participants for call ${callId} in room ${room}`, { participants: call.participants });
};

// Cleanup call data
const cleanupCall = (room, callId) => {
  if (activeCalls[room]?.[callId]) {
    log('CALL', `Cleaning up call ${callId} in room ${room}`);
    delete activeCalls[room][callId];
    delete signalingQueue[room]?.[callId];
    if (Object.keys(activeCalls[room]).length === 0) {
      delete activeCalls[room];
    }
  }
};

// Periodically process signaling queue (no syncUsers since it’s not in utils/users.js)
setInterval(() => {
  processSignalingQueue();
}, 1000);

io.on('connection', (socket) => {
  log('CONNECTION', `New connection: ${socket.id}`);

  socket.on('joinRoom', ({ username, room }) => {
    if (!username || !room) {
      log('ERROR', 'Invalid joinRoom data', { username, room });
      socket.emit('error', 'Username and room are required');
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
  });

  socket.on('chatMessage', ({ text, replyTo, room }) => {
    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) {
      log('ERROR', 'User not in room for chatMessage', { socketId: socket.id, room });
      socket.emit('error', 'You must join a room first');
      return;
    }

    const msg = formatMessage(user.username, text, replyTo);
    messageStore.addMessage(room, msg);
    io.to(room).emit('message', msg);
    log('MESSAGE', `Message sent in ${room} by ${user.username}`, { text });
  });

  socket.on('call-initiate', ({ room, callId, callType, caller }) => {
    if (!room || !callId || !callType || !caller) {
      log('ERROR', 'Invalid call-initiate data', { room, callId, callType, caller });
      socket.emit('error', 'Missing required call parameters');
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.username !== caller || user.room !== room) {
      log('ERROR', 'Unauthorized call initiation', { socketId: socket.id, caller, room });
      socket.emit('error', 'Unauthorized call initiation');
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
    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Call ${callId} not found in room ${room}`);
      socket.emit('error', 'Call not found');
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) {
      log('ERROR', 'User not identified for call-accepted', { socketId: socket.id });
      socket.emit('error', 'User not identified');
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
    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Offer received for non-existent call ${callId}`);
      socket.emit('error', `Call ${callId} not found`);
      return;
    }

    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      log('ERROR', `Unauthorized offer from ${sender?.username}`);
      socket.emit('error', 'Unauthorized offer');
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
    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Answer received for non-existent call ${callId}`);
      socket.emit('error', `Call ${callId} not found`);
      return;
    }

    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      log('ERROR', `Unauthorized answer from ${sender?.username}`);
      socket.emit('error', 'Unauthorized answer');
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
    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `ICE candidate for non-existent call ${callId}`);
      socket.emit('error', `Call ${callId} not found`);
      return;
    }

    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      log('ERROR', `Unauthorized ICE candidate from ${sender?.username}`);
      socket.emit('error', 'Unauthorized ICE candidate');
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

  socket.on('get-call-participants', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Call ${callId} not found`, { room });
      socket.emit('error', `Call ${callId} not found`);
      return;
    }
    socket.emit('call-participants', {
      callId,
      participants: call.participants
    });
  });

  socket.on('end-call', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      log('ERROR', `Call ${callId} not found in room ${room}`);
      socket.emit('error', `Call ${callId} not found`);
      return;
    }

    log('CALL', `Ending call ${callId} in ${room}`);
    io.to(room).emit('call-ended', { callId });
    cleanupCall(room, callId);
  });

  socket.on('reject-call', ({ room, callId, reason }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    const user = getCurrentUser(socket.id);
    if (!user) return;

    log('CALL', `Call ${callId} rejected by ${user.username}: ${reason}`);
    
    const callerSocket = findUserSocket(call.participants[0], room);
    if (callerSocket) {
      callerSocket.emit('reject-call', { 
        callId,
        userId: user.username,
        reason
      });
    }
    if (reason === 'busy' || call.participants.length <= 1) {
      io.to(room).emit('call-ended', { callId });
      cleanupCall(room, callId);
    }
  });

  socket.on('mute-state', ({ room, callId, isAudioMuted, userId }) => {
    io.to(room).emit('mute-state', { userId, isAudioMuted });
    log('CALL', `Mute state updated for ${userId} in call ${callId}`, { isAudioMuted });
  });

  socket.on('video-state', ({ room, callId, isVideoOff, userId }) => {
    io.to(room).emit('video-state', { userId, isVideoOff });
    log('CALL', `Video state updated for ${userId} in call ${callId}`, { isVideoOff });
  });

  socket.on('getCallState', () => {
    socket.emit('callState', {
      activeCalls,
      yourRooms: Array.from(socket.rooms)
    });
    log('CALL', `Call state requested by socket ${socket.id}`);
  });

  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
      log('CONNECTION', `${user.username} disconnected`);

      Object.entries(activeCalls).forEach(([room, calls]) => {
        Object.entries(calls).forEach(([callId, call]) => {
          const index = call.participants.indexOf(user.username);
          if (index !== -1) {
            call.participants.splice(index, 1);
            io.to(room).emit('user-left-call', {
              userId: user.username,
              callId
            });
            if (call.participants.length <= 1) {
              io.to(room).emit('call-ended', { callId });
              cleanupCall(room, callId);
            } else {
              broadcastCallParticipants(room, callId);
            }
          }
        });
      });

      const leaveMsg = formatMessage(botName, `${user.username} has left the chat`);
      messageStore.addMessage(user.room, leaveMsg);
      io.to(user.room).emit('message', leaveMsg);

      io.to(user.room).emit('roomUsers', {
        room: user.room,
        users: getRoomUsers(user.room)
      });
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => log('SERVER', `Server running on port ${PORT}`));