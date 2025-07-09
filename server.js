const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const formatMessage = require('./utils/messages');
const messageStore = require('./utils/messageStore');
const {
  userJoin,
  getCurrentUser,
  userLeave,
  getRoomUsers,
} = require('./utils/users');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.use(express.static(path.join(__dirname, 'public')));

const botName = 'ChatApp Bot';

io.on('connection', (socket) => {
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

  socket.on('chatMessage', ({ text, replyTo }) => {
    const user = getCurrentUser(socket.id);
    if (user && text.trim()) {
      const msg = {
        ...formatMessage(user.username, text, replyTo || null),
        id: uuidv4(),
        seenBy: [user.username] // Sender has seen it
      };
      
      // Store message
      messageStore.addMessage(user.room, msg);
      
      // Broadcast to room
      io.to(user.room).emit('message', msg);
    }
  });

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

  // Handle marking messages as seen
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

  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
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