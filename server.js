const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const formatMessage = require('./utils/messages');
const { userJoin, getCurrentUser, userLeave, getRoomUsers, syncUsers } = require('./utils/users');

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
};

// Process queued signaling messages
const processSignalingQueue = () => {
  Object.entries(signalingQueue).forEach(([room, calls]) => {
    Object.entries(calls).forEach(([callId, messages]) => {
      messages.forEach(({ event, data, retryCount }, index) => {
        if (retryCount >= 3 || Date.now() - data.timestamp > 10000) {
          console.error(`Failed to deliver ${event} to ${data.targetUser} after ${retryCount} retries`);
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
          console.log(`🛠️ Delivered queued ${event} to ${data.targetUser}`);
          messages.splice(index, 1);
        } else {
          console.log(`Retrying ${event} for ${data.targetUser} (attempt ${retryCount + 1})`);
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
  console.log(`📋 Call participants in ${room}:`, call.participants);
};

// Cleanup call data
const cleanupCall = (room, callId) => {
  if (activeCalls[room]?.[callId]) {
    console.log(`🧹 Cleaning up call ${callId} in room ${room}`);
    delete activeCalls[room][callId];
    delete signalingQueue[room]?.[callId];
    if (Object.keys(activeCalls[room]).length === 0) {
      delete activeCalls[room];
    }
  }
};

// Periodically sync users and process signaling queue
setInterval(() => {
  syncUsers(io.sockets.sockets);
  processSignalingQueue();
}, 1000);

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('joinRoom', ({ username, room }) => {
    if (!username || !room) {
      console.error('Invalid joinRoom data:', { username, room });
      socket.emit('error', 'Username and room are required');
      return;
    }

    const user = userJoin(socket.id, username, room);
    socket.join(user.room);

    console.log(`🔗 ${username} joined room ${room} (socket ${socket.id})`);
    
    socket.emit('message', formatMessage(botName, 'Welcome to ChatApp!'));
    socket.broadcast.to(user.room).emit('message', 
      formatMessage(botName, `${user.username} has joined the chat`));

    io.to(user.room).emit('roomUsers', {
      room: user.room,
      users: getRoomUsers(user.room)
    });
  });

  socket.on('chatMessage', ({ text, replyTo, room }) => {
    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) {
      socket.emit('error', 'You must join a room first');
      return;
    }

    const msg = formatMessage(user.username, text, replyTo);
    io.to(room).emit('message', msg);
  });

  socket.on('call-initiate', ({ room, callId, callType, caller }) => {
    if (!room || !callId || !callType || !caller) {
      console.error('Invalid call-initiate data:', { room, callId, callType, caller });
      socket.emit('error', 'Missing required call parameters');
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.username !== caller || user.room !== room) {
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

    console.log(`📞 Call initiated by ${caller} in ${room} (${callType}) ID:${callId}`);
    
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
      console.error(`Call ${callId} not found in room ${room}`);
      socket.emit('error', 'Call not found');
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user || user.room !== room) {
      socket.emit('error', 'User not identified');
      return;
    }

    if (!call.participants.includes(user.username)) {
      call.participants.push(user.username);
    }

    console.log(`✅ Call accepted by ${user.username} in ${room}`);
    
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
      console.error(`Offer received for non-existent call ${callId}`);
      socket.emit('error', `Call ${callId} not found`);
      return;
    }

    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      console.error(`Unauthorized offer from ${sender?.username}`);
      socket.emit('error', 'Unauthorized offer');
      return;
    }

    const targetSocket = findUserSocket(targetUser, room);
    if (targetSocket) {
      console.log(`📤 Forwarding offer from ${sender.username} to ${targetUser}`);
      targetSocket.emit('offer', { 
        offer, 
        callId, 
        userId: sender.username 
      });
    } else {
      console.warn(`Target user ${targetUser} not found in room ${room}, queuing offer`);
      queueSignalingMessage('offer', { offer, callId, userId: sender.username, targetUser, room, timestamp: Date.now() });
    }
  });

  socket.on('answer', ({ answer, room, callId, targetUser, userId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      console.error(`Answer received for non_ROLE: assistant: existent call ${callId}`);
      socket.emit('error', `Call ${callId} not found`);
      return;
    }

    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      console.error(`Unauthorized answer from ${sender?.username}`);
      socket.emit('error', 'Unauthorized answer');
      return;
    }

    const targetSocket = findUserSocket(targetUser, room);
    if (targetSocket) {
      console.log(`📥 Forwarding answer from ${sender.username} to ${targetUser}`);
      targetSocket.emit('answer', { 
        answer, 
        callId,
        userId: sender.username
      });
    } else {
      console.warn(`Target user ${targetUser} not found in room ${room}, queuing answer`);
      queueSignalingMessage('answer', { answer, callId, userId: sender.username, targetUser, room, timestamp: Date.now() });
    }
  });

  socket.on('ice-candidate', ({ candidate, room, callId, targetUser, userId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      console.error(`ICE candidate for non-existent call ${callId}`);
      socket.emit('error', `Call ${callId} not found`);
      return;
    }

    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      console.error(`Unauthorized ICE candidate from ${sender?.username}`);
      socket.emit('error', 'Unauthorized ICE candidate');
      return;
    }

    const targetSocket = findUserSocket(targetUser, room);
    if (targetSocket) {
      console.log(`🧊 Forwarding ICE candidate from ${sender.username} to ${targetUser}`);
      targetSocket.emit('ice-candidate', { 
        candidate, 
        callId,
        userId: sender.username
      });
    } else {
      console.warn(`Target user ${targetUser} not found in room ${room}, queuing ICE candidate`);
      queueSignalingMessage('ice-candidate', { candidate, callId, userId: sender.username, targetUser, room, timestamp: Date.now() });
    }
  });

  socket.on('get-call-participants', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
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
      console.error(`Call ${callId} not found in room ${room}`);
      socket.emit('error', `Call ${callId} not found`);
      return;
    }

    console.log(`📴 Ending call ${callId} in ${room}`);
    io.to(room).emit('call-ended', { callId });
    cleanupCall(room, callId);
  });

  socket.on('reject-call', ({ room, callId, reason }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    const user = getCurrentUser(socket.id);
    if (!user) return;

    console.log(`❌ Call ${callId} rejected by ${user.username}: ${reason}`);
    
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
  });

  socket.on('video-state', ({ room, callId, isVideoOff, userId }) => {
    io.to(room).emit('video-state', { userId, isVideoOff });
  });

  socket.on('getCallState', () => {
    socket.emit('callState', {
      activeCalls,
      yourRooms: Array.from(socket.rooms)
    });
  });

  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
      console.log(`🚪 ${user.username} disconnected`);

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

      io.to(user.room).emit('message', 
        formatMessage(botName, `${user.username} has left the chat`));

      io.to(user.room).emit('roomUsers', {
        room: user.room,
        users: getRoomUsers(user.room)
      });
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));