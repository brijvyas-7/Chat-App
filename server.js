const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const formatMessage = require('./utils/messages');
const messageStore = require('./utils/messageStore');
const { userJoin, getCurrentUser, userLeave, getRoomUsers } = require('./utils/users');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Set static folder
app.use(express.static(path.join(__dirname, 'public')));

const botName = 'ChatApp Bot';

// Track active calls by room
const activeCalls = {};

io.on('connection', (socket) => {
  console.log(`New WebSocket connection: ${socket.id}`);

  // Join chat room
  socket.on('joinRoom', ({ username, room }) => {
    const user = userJoin(socket.id, username, room);
    socket.join(user.room);

    // Send message history
    const history = messageStore.getMessages(user.room);
    socket.emit('messageHistory', history);

    // Welcome message
    const welcomeMsg = {
      ...formatMessage(botName, 'Welcome to Chat App'),
      id: uuidv4()
    };
    socket.emit('message', welcomeMsg);

    // User join notification
    const joinMsg = {
      ...formatMessage(botName, `${user.username} has joined the chat`),
      id: uuidv4()
    };
    socket.broadcast.to(user.room).emit('message', joinMsg);

    // Send room users
    io.to(user.room).emit('roomUsers', {
      room: user.room,
      users: getRoomUsers(user.room),
    });
  });

  // Handle chat messages
  socket.on('chatMessage', ({ text, replyTo }) => {
    const user = getCurrentUser(socket.id);
    if (user && text.trim()) {
      const msg = {
        ...formatMessage(user.username, text, replyTo || null),
        id: uuidv4(),
        seenBy: [user.username]
      };
      
      // Store message
      messageStore.addMessage(user.room, msg);
      
      // Broadcast to room
      io.to(user.room).emit('message', msg);
    }
  });

  // Typing indicators
  socket.on('typing', () => {
    const user = getCurrentUser(socket.id);
    if (user) {
      socket.broadcast.to(user.room).emit('showTyping', {
        username: user.username
      });
    }
  });

  socket.on('stopTyping', () => {
    const user = getCurrentUser(socket.id);
    if (user) {
      socket.broadcast.to(user.room).emit('stopTyping');
    }
  });

  // Mark messages as seen
  socket.on('markAsSeen', ({ messageIds, room }) => {
    const user = getCurrentUser(socket.id);
    if (user) {
      const updates = [];
      
      messageIds.forEach(id => {
        if (messageStore.markAsSeen(room, id, user.username)) {
          updates.push({
            messageId: id,
            seenBy: messageStore.getMessages(room).find(m => m.id === id).seenBy
          });
        }
      });
      
      if (updates.length > 0) {
        io.to(room).emit('messagesSeen', updates);
      }
    }
  });

  /* ====================== */
  /* ENHANCED CALL HANDLERS */
  /* ====================== */

  // Handle call initiation (both audio and video)
  socket.on('call-initiate', ({ room, callType, callId }) => {
    const user = getCurrentUser(socket.id);
    if (!user) return;

    if (!activeCalls[room]) {
      activeCalls[room] = {};
    }
    
    activeCalls[room][callId] = {
      callType,
      participants: {
        [user.username]: socket.id
      },
      offers: {},
      answers: {},
      iceCandidates: {}
    };

    // Notify other users in the room
    socket.to(room).emit('incoming-call', {
      callType,
      callId,
      caller: user.username
    });
  });

  // Handle call acceptance
  socket.on('accept-call', ({ room, callId }) => {
    const user = getCurrentUser(socket.id);
    const call = activeCalls[room]?.[callId];
    
    if (call && user) {
      // Add participant to the call
      call.participants[user.username] = socket.id;
      
      // Notify all participants about the new user
      Object.entries(call.participants).forEach(([username, participantSocket]) => {
        if (participantSocket !== socket.id) {
          io.to(participantSocket).emit('user-joined-call', {
            userId: user.username,
            callId
          });
        }
      });
    }
  });

  // Handle offer exchange between peers
  socket.on('offer', ({ offer, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (call && call.participants[targetUser]) {
      call.offers[targetUser] = offer;
      io.to(call.participants[targetUser]).emit('offer', {
        offer,
        callId,
        userId: getCurrentUser(socket.id)?.username
      });
    }
  });

  // Handle answer exchange between peers
  socket.on('answer', ({ answer, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (call && call.participants[targetUser]) {
      call.answers[targetUser] = answer;
      io.to(call.participants[targetUser]).emit('answer', {
        answer,
        callId,
        userId: getCurrentUser(socket.id)?.username
      });
    }
  });

  // Handle ICE candidates exchange
  socket.on('ice-candidate', ({ candidate, room, callId, targetUser }) => {
    const call = activeCalls[room]?.[callId];
    if (call && call.participants[targetUser]) {
      // Queue candidate if we don't have the target user's socket yet
      if (!call.iceCandidates[targetUser]) {
        call.iceCandidates[targetUser] = [];
      }
      call.iceCandidates[targetUser].push(candidate);
      
      // Forward to target user
      io.to(call.participants[targetUser]).emit('ice-candidate', {
        candidate,
        callId,
        userId: getCurrentUser(socket.id)?.username
      });
    }
  });

  // Handle user leaving a call
  socket.on('leave-call', ({ room, callId }) => {
    const user = getCurrentUser(socket.id);
    const call = activeCalls[room]?.[callId];
    
    if (call && user) {
      // Remove participant
      delete call.participants[user.username];
      delete call.offers[user.username];
      delete call.answers[user.username];
      delete call.iceCandidates[user.username];
      
      // Notify remaining participants
      Object.entries(call.participants).forEach(([username, participantSocket]) => {
        io.to(participantSocket).emit('user-left-call', {
          userId: user.username,
          callId
        });
      });
      
      // Clean up if no participants left
      if (Object.keys(call.participants).length === 0) {
        delete activeCalls[room][callId];
      }
    }
  });

  // Handle call rejection
  socket.on('reject-call', ({ room, callId, reason }) => {
    const call = activeCalls[room]?.[callId];
    const user = getCurrentUser(socket.id);
    
    if (call && user) {
      // Notify caller
      const callerSocket = call.participants[call.caller];
      if (callerSocket) {
        io.to(callerSocket).emit('reject-call', { 
          callId, 
          reason: reason || 'rejected',
          userId: user.username
        });
      }
      
      // Clean up if no other participants
      if (Object.keys(call.participants).length <= 1) {
        delete activeCalls[room][callId];
      }
    }
  });

  // Handle full call termination
  socket.on('end-call', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (call) {
      // Notify all participants
      Object.values(call.participants).forEach(participantSocket => {
        io.to(participantSocket).emit('end-call', { callId });
      });
      
      // Clean up
      delete activeCalls[room][callId];
    }
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
      // Clean up any active calls
      if (activeCalls[user.room]) {
        Object.entries(activeCalls[user.room]).forEach(([callId, call]) => {
          if (call.participants[user.username]) {
            // Notify other participants
            Object.entries(call.participants).forEach(([username, participantSocket]) => {
              if (participantSocket !== socket.id) {
                io.to(participantSocket).emit('user-left-call', {
                  userId: user.username,
                  callId
                });
              }
            });
            
            // Remove from call
            delete call.participants[user.username];
            delete call.offers[user.username];
            delete call.answers[user.username];
            delete call.iceCandidates[user.username];
            
            // Clean up if empty
            if (Object.keys(call.participants).length === 0) {
              delete activeCalls[user.room][callId];
            }
          }
        });
      }

      // Notify room about user leaving
      const leaveMsg = {
        ...formatMessage(botName, `${user.username} has left the chat`),
        id: uuidv4()
      };
      io.to(user.room).emit('message', leaveMsg);

      // Update room users
      io.to(user.room).emit('roomUsers', {
        room: user.room,
        users: getRoomUsers(user.room),
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));