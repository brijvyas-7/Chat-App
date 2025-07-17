const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const activeCalls = {};

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Room joining
  socket.on('joinRoom', ({ username, room }) => {
    socket.join(room);
    console.log(`${username} joined ${room}`);
  });

  /* ====================== */
  /* Enhanced Call Handling */
  /* ====================== */

  // Call initiation
  socket.on('initiate-call', ({ room, callType }) => {
    const callId = uuidv4();
    activeCalls[room] = activeCalls[room] || {};
    activeCalls[room][callId] = {
      callType,
      participants: {},
      offers: {},
      answers: {},
      iceCandidates: {}
    };

    socket.emit('call-initiated', { callId });
    socket.to(room).emit('incoming-call', { callId, callType, caller: socket.id });
  });

  // Call acceptance
  socket.on('accept-call', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (!call) return;

    call.participants[socket.id] = true;
    socket.to(room).emit('call-accepted', { callId });
  });

  // Signaling: Offer
  socket.on('offer', ({ offer, room, callId, targetSocketId }) => {
    console.log(`Offer relayed to ${targetSocketId}`);
    socket.to(targetSocketId).emit('offer', { offer, callId, senderSocketId: socket.id });
  });

  // Signaling: Answer
  socket.on('answer', ({ answer, room, callId, targetSocketId }) => {
    console.log(`Answer relayed to ${targetSocketId}`);
    socket.to(targetSocketId).emit('answer', { answer, callId, senderSocketId: socket.id });
  });

  // Signaling: ICE Candidates
  socket.on('ice-candidate', ({ candidate, room, callId, targetSocketId }) => {
    socket.to(targetSocketId).emit('ice-candidate', { 
      candidate, 
      callId,
      senderSocketId: socket.id 
    });
  });

  // Call termination
  socket.on('end-call', ({ room, callId }) => {
    socket.to(room).emit('call-ended', { callId });
    if (activeCalls[room]?.[callId]) {
      delete activeCalls[room][callId];
    }
  });

  // Disconnection
  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));