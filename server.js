const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
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

// Set static folder
app.use(express.static(path.join(__dirname, 'public')));

const botName = 'ChatApp Bot';

io.on('connection', (socket) => {
  // When a user joins a room
  socket.on('joinRoom', ({ username, room }) => {
    const user = userJoin(socket.id, username, room);
    socket.join(user.room);

    // Welcome the current user
    socket.emit('message', formatMessage(botName, 'Welcome to Android Messaging Chat App'));

    // Broadcast to others that user has joined
    socket.broadcast.to(user.room).emit(
      'message',
      formatMessage(botName, `${user.username} has joined the chat`)
    );

    // Send updated room and user list
    io.to(user.room).emit('roomUsers', {
      room: user.room,
      users: getRoomUsers(user.room),
    });
  });

  // Handle message (normal or with reply)
  socket.on('chatMessage', (data) => {
    const user = getCurrentUser(socket.id);

    if (user) {
      // If plain text string, treat as normal message
      const message =
        typeof data === 'string'
          ? formatMessage(user.username, data)
          : {
              username: user.username,
              text: data.text,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              replyTo: data.replyTo || null,
            };

      io.to(user.room).emit('message', message);
    }
  });

  // Typing event
  socket.on('typing', () => {
    const user = getCurrentUser(socket.id);
    if (user) {
      socket.broadcast.to(user.room).emit('showTyping', { username: user.username });
    }
  });

  socket.on('stopTyping', () => {
    const user = getCurrentUser(socket.id);
    if (user) {
      socket.broadcast.to(user.room).emit('hideTyping');
    }
  });

  // User disconnects
  socket.on('disconnect', () => {
    const user = userLeave(socket.id);

    if (user) {
      io.to(user.room).emit(
        'message',
        formatMessage(botName, `${user.username} has left the chat`)
      );

      io.to(user.room).emit('roomUsers', {
        room: user.room,
        users: getRoomUsers(user.room),
      });
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
