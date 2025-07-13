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

// WebRTC signaling state
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
  /* VIDEO CALL HANDLERS */
  /* ====================== */

  // Handle call initiation
  socket.on('video-call-initiate', ({ offer, room, callId, caller }) => {
    if (!activeCalls[room]) {
      activeCalls[room] = {};
    }
    
    activeCalls[room][callId] = {
      caller,
      callee: null,
      offer,
      answer: null,
      callerSocket: socket.id
    };

    // Notify other users in the room
    socket.to(room).emit('incoming-call', {
      offer,
      callId,
      caller
    });
  });

  // Handle call answer
  socket.on('video-answer', ({ answer, room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (call) {
      call.answer = answer;
      
      // Send answer to caller
      io.to(call.callerSocket).emit('video-answer', {
        answer,
        callId
      });
    }
  });

  // Handle ICE candidates
  socket.on('ice-candidate', ({ candidate, room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (call) {
      const targetSocket = socket.id === call.callerSocket 
        ? call.calleeSocket 
        : call.callerSocket;
      
      if (targetSocket) {
        io.to(targetSocket).emit('ice-candidate', {
          candidate,
          callId
        });
      }
    }
  });

  // Handle call end
  socket.on('end-call', ({ room, callId }) => {
    const call = activeCalls[room]?.[callId];
    if (call) {
      // Notify other participant
      const targetSocket = socket.id === call.callerSocket 
        ? call.calleeSocket 
        : call.callerSocket;
      
      if (targetSocket) {
        io.to(targetSocket).emit('end-call', { callId });
      }
      
      // Clean up
      delete activeCalls[room][callId];
      if (Object.keys(activeCalls[room]).length === 0) {
        delete activeCalls[room];
      }
    }
  });

  // Handle call rejection
  socket.on('reject-call', ({ room, callId, reason }) => {
    const call = activeCalls[room]?.[callId];
    if (call) {
      // Notify caller
      io.to(call.callerSocket).emit('reject-call', { 
        callId, 
        reason: reason || 'rejected' 
      });
      
      // Clean up
      delete activeCalls[room][callId];
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
      // Clean up any active calls
      if (activeCalls[user.room]) {
        Object.keys(activeCalls[user.room]).forEach(callId => {
          const call = activeCalls[user.room][callId];
          if (call.callerSocket === socket.id || call.calleeSocket === socket.id) {
            const targetSocket = socket.id === call.callerSocket 
              ? call.calleeSocket 
              : call.callerSocket;
            
            if (targetSocket) {
              io.to(targetSocket).emit('end-call', { callId });
            }
            
            delete activeCalls[user.room][callId];
          }
        });
      }

      const leaveMsg = {
        ...formatMessage(botName, `${user.username} has left the chat`),
        id: uuidv4()
      };
      io.to(user.room).emit('message', leaveMsg);

      io.to(user.room).emit('roomUsers', {
        room: user.room,
        users: getRoomUsers(user.room),
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));