const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const { v4: uuidv4 } = require('uuid'); // ✅ NEW: Unique ID for each message
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

// Serve static files from "public" folder
app.use(express.static(path.join(__dirname, 'public')));

const botName = 'ChatApp Bot';

io.on('connection', (socket) => {
  // User joins a room
  socket.on('joinRoom', ({ username, room }) => {
    const user = userJoin(socket.id, username, room);
    socket.join(user.room);

    // Welcome message to the joining user
    socket.emit('message', {
      ...formatMessage(botName, 'Welcome to Chat App'),
      id: uuidv4() // ✅ Attach ID
    });

    // Notify others in the room
    socket.broadcast.to(user.room).emit(
      'message',
      {
        ...formatMessage(botName, `${user.username} has joined the chat`),
        id: uuidv4()
      }
    );

    // Send updated user list
    io.to(user.room).emit('roomUsers', {
      room: user.room,
      users: getRoomUsers(user.room),
    });
  });

  // Incoming chat message with optional reply
  socket.on('chatMessage', ({ text, replyTo }) => {
    const user = getCurrentUser(socket.id);
    if (user && text.trim()) {
      const msg = formatMessage(user.username, text, replyTo || null);
      msg.id = uuidv4(); // ✅ Add unique ID
      io.to(user.room).emit('message', msg);
    }
  });

  // Typing indicator
  socket.on('typing', () => {
    const user = getCurrentUser(socket.id);
    if (user) {
      socket.broadcast
        .to(user.room)
        .emit('showTyping', { username: user.username });
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
        {
          ...formatMessage(botName, `${user.username} has left the chat`),
          id: uuidv4()
        }
      );

      // Update room user list
      io.to(user.room).emit('roomUsers', {
        room: user.room,
        users: getRoomUsers(user.room),
      });
    }
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
