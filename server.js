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

  // Room joining
  socket.on('joinRoom', ({ username, room }) => {
    const user = userJoin(socket.id, username, room);
    socket.join(user.room);

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

  // Typing indicators
  socket.on('typing', ({ room }) => {
    const user = getCurrentUser(socket.id);
    if (user) {
      socket.broadcast.to(room).emit('showTyping', { username: user.username });
    }
  });

  socket.on('stopTyping', ({ room }) => {
    socket.broadcast.to(room).emit('stopTyping');
  });

  /* ====================== */
  /* Enhanced Call Handling */
  /* ====================== */

  // Call initiation
  socket.on('call-initiate', (data) => {
    const { room, callType, caller } = data;
    const callId = uuidv4();
    
    activeCalls[room] = activeCalls[room] || {};
    activeCalls[room][callId] = {
      callId,
      callType,
      participants: [caller],
      offers: {},
      answers: {},
      iceCandidates: {}
    };

    console.log(`Call initiated by ${caller} in ${room} (${callType})`);
    socket.to(room).emit('incoming-call', { 
      callId, 
      callType, 
      caller 
    });
  });

  // Call acceptance
  socket.on('accept-call', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    const user = getCurrentUser(socket.id);
    if (!user) return;

    call.participants.push(user.username);
    console.log(`Call accepted by ${user.username} in ${room}`);
    
    // Notify all participants about the new participant
    io.to(room).emit('user-joined-call', { 
      userId: user.username,
      callId
    });
    
    // Send the acceptance to the caller
    socket.to(room).emit('call-accepted', { 
      callId,
      userId: user.username 
    });
  });

  // Get call participants
  socket.on('get-call-participants', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    socket.emit('call-participants', {
      callId,
      participants: call.participants.filter(p => p !== getCurrentUser(socket.id)?.username)
    });
  });

  // Signaling: Offer
  socket.on('offer', ({ offer, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    call.offers[targetUser] = offer;
    console.log(`Forwarding offer from ${getCurrentUser(socket.id)?.username} to ${targetUser}`);
    socket.to(room).emit('offer', { 
      offer, 
      callId, 
      userId: getCurrentUser(socket.id)?.username,
      targetUser 
    });
  });

  // Signaling: Answer
  socket.on('answer', ({ answer, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    call.answers[targetUser] = answer;
    console.log(`Forwarding answer from ${getCurrentUser(socket.id)?.username} to ${targetUser}`);
    socket.to(room).emit('answer', { 
      answer, 
      callId,
      userId: getCurrentUser(socket.id)?.username,
      targetUser 
    });
  });

  // Signaling: ICE Candidates
  socket.on('ice-candidate', ({ candidate, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    call.iceCandidates[targetUser] = call.iceCandidates[targetUser] || [];
    call.iceCandidates[targetUser].push(candidate);
    console.log(`Forwarding ICE candidate from ${getCurrentUser(socket.id)?.username} to ${targetUser}`);
    socket.to(room).emit('ice-candidate', { 
      candidate, 
      callId,
      userId: getCurrentUser(socket.id)?.username,
      targetUser 
    });
  });

  // Mute state
  socket.on('mute-state', ({ room, callId, isAudioMuted, userId }) => {
    console.log(`User ${userId} ${isAudioMuted ? 'muted' : 'unmuted'} audio`);
    socket.to(room).emit('mute-state', {
      callId,
      userId,
      isAudioMuted
    });
  });

  // Video state
  socket.on('video-state', ({ room, callId, isVideoOff, userId }) => {
    console.log(`User ${userId} ${isVideoOff ? 'disabled' : 'enabled'} video`);
    socket.to(room).emit('video-state', {
      callId,
      userId,
      isVideoOff
    });
  });

  // Call termination
  socket.on('end-call', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    console.log(`Call ${callId} ended in room ${room}`);
    socket.to(room).emit('call-ended', { callId });
    delete activeCalls[room][callId];
  });

  // Call rejection
  socket.on('reject-call', ({ room, callId, reason }) => {
    console.log(`Call ${callId} rejected in room ${room}: ${reason}`);
    socket.to(room).emit('call-rejected', { callId, reason });
  });

  // User leaving the call
  socket.on('leave-call', ({ room, callId }) => {
    const user = getCurrentUser(socket.id);
    if (!user) return;

    console.log(`User ${user.username} left call ${callId} in room ${room}`);
    socket.to(room).emit('user-left-call', { 
      userId: user.username,
      callId
    });
  });

  // Disconnection
  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
      io.to(user.room).emit('message', 
        formatMessage(botName, `${user.username} has left the chat`));

      // Send users and room info
      io.to(user.room).emit('roomUsers', {
        room: user.room,
        users: getRoomUsers(user.room)
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));