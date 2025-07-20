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
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const botName = 'ChatApp Bot';
const activeCalls = {};

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Enhanced room joining with validation
  socket.on('joinRoom', ({ username, room }) => {
    if (!username || !room) {
      console.error('Invalid joinRoom data:', { username, room });
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

  // Listen for chatMessage
  socket.on('chatMessage', ({ text, replyTo, room }) => {
    const user = getCurrentUser(socket.id);
    if (!user) return;

    const msg = formatMessage(user.username, text, replyTo);
    io.to(room).emit('message', msg);
  });

  /* ====================== */
  /* Fixed Call Handling */
  /* ====================== */

  // Call initiation - FIXED: Preserve client's callId
  socket.on('call-initiate', ({ room, callId, callType, caller }) => {
    if (!room || !callId || !callType || !caller) {
      console.error('Invalid call-initiate data:', { room, callId, callType, caller });
      return;
    }

    activeCalls[room] = activeCalls[room] || {};
    activeCalls[room][callId] = {
      callId,
      callType,
      participants: [caller],
      offers: {},
      answers: {},
      iceCandidates: {}
    };

    console.log(`📞 Call initiated by ${caller} in ${room} (${callType}) ID:${callId}`);
    
    // Verify room exists before emitting
    const roomSockets = io.sockets.adapter.rooms.get(room);
    console.log(`Members in ${room}:`, roomSockets ? Array.from(roomSockets) : 'None');
    
    socket.to(room).emit('incoming-call', { 
      callId, 
      callType, 
      caller 
    });
  });

  // Call acceptance - FIXED: Better participant tracking
  socket.on('accept-call', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) {
      console.error(`Call ${callId} not found in room ${room}`);
      return;
    }

    const user = getCurrentUser(socket.id);
    if (!user) return;

    // Prevent duplicate participants
    if (!call.participants.includes(user.username)) {
      call.participants.push(user.username);
    }

    console.log(`✅ Call accepted by ${user.username} in ${room}`);
    
    // Notify all participants
    io.to(room).emit('user-joined-call', { 
      userId: user.username,
      callId
    });
    
    // Send acceptance specifically to caller
    const callerSocket = Object.values(io.sockets.sockets).find(
      s => getCurrentUser(s.id)?.username === call.participants[0]
    );
    if (callerSocket) {
      callerSocket.emit('accept-call', { 
        callId,
        userId: user.username 
      });
    }
  });

  // Signaling: Offer - FIXED: Targeted emission
  socket.on('offer', ({ offer, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    call.offers[targetUser] = offer;
    
    const targetSocket = Object.values(io.sockets.sockets).find(
      s => getCurrentUser(s.id)?.username === targetUser
    );
    
    if (targetSocket) {
      console.log(`📤 Forwarding offer to ${targetUser} in ${room}`);
      targetSocket.emit('offer', { 
        offer, 
        callId, 
        userId: getCurrentUser(socket.id)?.username 
      });
    }
  });

  // Signaling: Answer - FIXED: Targeted emission
  socket.on('answer', ({ answer, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    call.answers[targetUser] = answer;
    
    const targetSocket = Object.values(io.sockets.sockets).find(
      s => getCurrentUser(s.id)?.username === targetUser
    );
    
    if (targetSocket) {
      console.log(`📥 Forwarding answer to ${targetUser} in ${room}`);
      targetSocket.emit('answer', { 
        answer, 
        callId,
        userId: getCurrentUser(socket.id)?.username
      });
    }
  });

  // Signaling: ICE Candidates - FIXED: Targeted emission
  socket.on('ice-candidate', ({ candidate, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    call.iceCandidates[targetUser] = call.iceCandidates[targetUser] || [];
    call.iceCandidates[targetUser].push(candidate);
    
    const targetSocket = Object.values(io.sockets.sockets).find(
      s => getCurrentUser(s.id)?.username === targetUser
    );
    
    if (targetSocket) {
      console.log(`🧊 Forwarding ICE candidate to ${targetUser}`);
      targetSocket.emit('ice-candidate', { 
        candidate, 
        callId,
        userId: getCurrentUser(socket.id)?.username
      });
    }
  });

  // Call termination - FIXED: Proper cleanup
  socket.on('end-call', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    console.log(`📴 Ending call ${callId} in ${room}`);
    io.to(room).emit('call-ended', { callId });
    
    // Cleanup call data
    if (activeCalls[room]) {
      delete activeCalls[room][callId];
      if (Object.keys(activeCalls[room]).length === 0) {
        delete activeCalls[room];
      }
    }
  });

  // Disconnection - FIXED: Call cleanup
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
              delete calls[callId];
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));