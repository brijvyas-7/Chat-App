const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const formatMessage = require('./utils/messages');
const {
  userJoin,
  getCurrentUser,
  userLeave,
  getRoomUsers,
} = require('./utils/users');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

// ✅ Serve static files
app.use(express.static(path.join(__dirname, 'public')));

const botName = 'ChatApp Bot';

io.on('connection', (socket) => {
  // ✅ Join Room
  socket.on('joinRoom', ({ username, room }) => {
    const user = userJoin(socket.id, username, room);
    socket.join(user.room);

    // ✅ Welcome message to user
    socket.emit('message', {
      ...formatMessage(botName, 'Welcome to Chat App'),
      id: uuidv4()
    });

    // ✅ Notify others
    socket.broadcast.to(user.room).emit('message', {
      ...formatMessage(botName, `${user.username} has joined the chat`),
      id: uuidv4()
    });

    // ✅ Send room data
    io.to(user.room).emit('roomUsers', {
      room: user.room,
      users: getRoomUsers(user.room),
    });
  });

  // ✅ Chat message
  socket.on('chatMessage', ({ text, replyTo }) => {
    const user = getCurrentUser(socket.id);
    if (user && text.trim()) {
      const msg = formatMessage(user.username, text, replyTo || null);
      msg.id = uuidv4();
      io.to(user.room).emit('message', msg);
    }
  });

  // ✅ Typing indicator
  socket.on('typing', () => {
    const user = getCurrentUser(socket.id);
    if (user) {
      socket.broadcast.to(user.room).emit('showTyping', {
        username: user.username
      });
    }
  });

  // ✅ Optional: stopTyping (can be expanded in frontend)
  socket.on('stopTyping', () => {
    const user = getCurrentUser(socket.id);
    if (user) {
      socket.broadcast.to(user.room).emit('hideTyping');
    }
  });

  // ✅ User disconnects
  socket.on('disconnect', () => {
    const user = userLeave(socket.id);
    if (user) {
      io.to(user.room).emit('message', {
        ...formatMessage(botName, `${user.username} has left the chat`),
        id: uuidv4()
      });

      io.to(user.room).emit('roomUsers', {
        room: user.room,
        users: getRoomUsers(user.room),
      });
    }
  });
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
