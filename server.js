const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const formatMessage = require('./utils/messages');
const { userJoin, getCurrentUser, userLeave, getRoomUsers } = require('./utils/users');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Improved WebSocket configuration
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

const botName = 'ChatApp Bot';
const activeCalls = {};

// Utility function to find user socket
const findUserSocket = (username) => {
  return Object.values(io.sockets.sockets).find(
    s => getCurrentUser(s.id)?.username === username
  );
};

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Enhanced room joining with validation
  socket.on('joinRoom', ({ username, room }) => {
    if (!username || !room) {
      console.error('Invalid joinRoom data:', { username, room });
      socket.emit('error', 'Username and room are required');
      return;
    }

    const user = userJoin(socket.id, username, room);
    socket.join(user.room);

    console.log(`🔗 ${username} joined room ${room} (socket ${socket.id})`);
    
    // Welcome current user
    socket.emit('message', formatMessage(botName, 'Welcome to ChatApp!'));

    // Broadcast when a user connects
    socket.broadcast.to(user.room).emit('message', 
      formatMessage(botName, `${user.username} has joined the chat`));

    // Send users and room info
    io.to(user.room).emit('roomUsers', {
      room: user.room,
      users: getRoomUsers(user.room)
    });
  });

  // Listen for chatMessage with validation
  socket.on('chatMessage', ({ text, replyTo, room }) => {
    const user = getCurrentUser(socket.id);
    if (!user) {
      socket.emit('error', 'You must join a room first');
      return;
    }

    const msg = formatMessage(user.username, text, replyTo);
    io.to(room).emit('message', msg);
  });

  /* ====================== */
  /* Enhanced Call Handling */
  /* ====================== */

  // Call initiation with validation
  socket.on('call-initiate', ({ room, callId, callType, caller }) => {
    if (!room || !callId || !callType || !caller) {
      console.error('Invalid call-initiate data:', { room, callId, callType, caller });
      socket.emit('error', 'Missing required call parameters');
      return;
    }

    // Initialize call structure
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
    
    // Clean up old calls in this room
    Object.keys(activeCalls[room]).forEach(id => {
      if (id !== callId && Date.now() - activeCalls[room][id].timestamp > 3600000) {
        delete activeCalls[room][id];
      }
    });

    // Send call invitation to all room members except caller
    socket.to(room).emit('incoming-call', { 
      callId, 
      callType, 
      caller 
    });
  });

  // Call acceptance with validation
  socket.on('call-accepted', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      console.error(`Call ${callId} not found in room ${room}`);
      socket.emit('error', 'Call not found');
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user) {
      socket.emit('error', 'User not identified');
      return;
    }

    // Prevent duplicate participants
    if (!call.participants.includes(user.username)) {
      call.participants.push(user.username);
    }

    console.log(`✅ Call accepted by ${user.username} in ${room}`);
    
    // Notify all participants about the new participant
    io.to(room).emit('user-joined-call', { 
      userId: user.username,
      callId
    });
    
    // Send acceptance specifically to caller
    const callerSocket = findUserSocket(call.participants[0]);
    if (callerSocket) {
      callerSocket.emit('call-accepted', { 
        callId,
        userId: user.username 
      });
    }
  });

  // Enhanced offer handling
  socket.on('offer', ({ offer, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      console.error(`Offer received for non-existent call ${callId}`);
      return;
    }

    // Validate the sender is in the call
    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      console.error(`Unauthorized offer from ${sender?.username}`);
      return;
    }

    call.offers[targetUser] = offer;
    
    const targetSocket = findUserSocket(targetUser);
    if (targetSocket) {
      console.log(`📤 Forwarding offer to ${targetUser}`);
      targetSocket.emit('offer', { 
        offer, 
        callId, 
        userId: sender.username 
      });
    } else {
      console.error(`Target user ${targetUser} not found`);
    }
  });

  // Enhanced answer handling
  socket.on('answer', ({ answer, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      console.error(`Answer received for non-existent call ${callId}`);
      return;
    }

    // Validate the sender is in the call
    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      console.error(`Unauthorized answer from ${sender?.username}`);
      return;
    }

    call.answers[targetUser] = answer;
    
    const targetSocket = findUserSocket(targetUser);
    if (targetSocket) {
      console.log(`📥 Forwarding answer to ${targetUser}`);
      targetSocket.emit('answer', { 
        answer, 
        callId,
        userId: sender.username
      });
    } else {
      console.error(`Target user ${targetUser} not found`);
    }
  });

  // Enhanced ICE candidate handling
  socket.on('ice-candidate', ({ candidate, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      console.error(`ICE candidate for non-existent call ${callId}`);
      return;
    }

    // Validate the sender is in the call
    const sender = getCurrentUser(socket.id);
    if (!sender || !call.participants.includes(sender.username)) {
      console.error(`Unauthorized ICE candidate from ${sender?.username}`);
      return;
    }

    call.iceCandidates[targetUser] = call.iceCandidates[targetUser] || [];
    call.iceCandidates[targetUser].push(candidate);
    
    const targetSocket = findUserSocket(targetUser);
    if (targetSocket) {
      console.log(`🧊 Forwarding ICE candidate to ${targetUser}`);
      targetSocket.emit('ice-candidate', { 
        candidate, 
        callId,
        userId: sender.username
      });
    } else {
      console.error(`Target user ${targetUser} not found`);
    }
  });

  // New: Get call participants
  socket.on('get-call-participants', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    socket.emit('call-participants', {
      callId,
      participants: call.participants
    });
  });

  // Enhanced call termination
  socket.on('end-call', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    console.log(`📴 Ending call ${callId} in ${room}`);
    io.to(room).emit('call-ended', { callId });
    
    // Cleanup call data
    cleanupCall(room, callId);
  });

  // New: Call rejection handler
  socket.on('reject-call', ({ room, callId, reason }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    const user = getCurrentUser(socket.id);
    if (!user) return;

    console.log(`❌ Call rejected by ${user.username}: ${reason}`);
    
    // Notify caller
    const callerSocket = findUserSocket(call.participants[0]);
    if (callerSocket) {
      callerSocket.emit('call-rejected', { 
        callId,
        userId: user.username,
        reason
      });
    }
  });

  // Enhanced disconnection handler
  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
      console.log(`🚪 ${user.username} disconnected`);
      
      // Cleanup any calls they were in
      Object.entries(activeCalls).forEach(([room, calls]) => {
        Object.entries(calls).forEach(([callId, call]) => {
          if (call.participants.includes(user.username)) {
            io.to(room).emit('user-left-call', {
              userId: user.username,
              callId
            });
            
            if (call.participants.length <= 1) {
              io.to(room).emit('call-ended', { callId });
              cleanupCall(room, callId);
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

  // Debug endpoint
  socket.on('getCallState', () => {
    socket.emit('callState', {
      activeCalls,
      yourRooms: Array.from(socket.rooms)
    });
  });
});

// Helper function to clean up calls
function cleanupCall(room, callId) {
  if (activeCalls[room]) {
    delete activeCalls[room][callId];
    if (Object.keys(activeCalls[room]).length === 0) {
      delete activeCalls[room];
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));