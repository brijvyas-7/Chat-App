const chatForm = document.getElementById('chat-form');
const chatMessages = document.getElementById('chat-messages');
const roomName = document.getElementById('room-name');
const userList = document.getElementById('users');

// Get username and room from URL using Qs library
const { username, room } = Qs.parse(location.search, {
  ignoreQueryPrefix: true,
});

const socket = io();

// Join chatroom
socket.emit('joinRoom', { username, room });

// Update room name and user list
socket.on('roomUsers', ({ room, users }) => {
  outputRoomName(room);
  outputUsers(users);
});

// Receive message from server
socket.on('message', (message) => {
  outputMessage(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Submit message
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const msgInput = e.target.elements.msg;
  const msg = msgInput.value.trim();
  if (!msg) return;

  socket.emit('chatMessage', msg);
  msgInput.value = '';
  msgInput.focus();
});

// Output message to DOM
function outputMessage({ username, text, time }) {
  const div = document.createElement('div');
  div.classList.add('message');
  div.classList.add(username === 'ChatApp Bot' ? 'bot' : 'user');

  div.innerHTML = `
    <div class="fw-bold">${username} <span class="text-muted small ms-2">${time}</span></div>
    <div>${text}</div>
  `;

  chatMessages.appendChild(div);
}

// Set room name
function outputRoomName(room) {
  roomName.innerText = room;
}

// List users
function outputUsers(users) {
  if (!userList) return;
  userList.innerHTML = '';
  users.forEach(({ username }) => {
    const li = document.createElement('li');
    li.classList.add('list-group-item');
    li.textContent = username;
    userList.appendChild(li);
  });
}

// Confirm leave
const leaveBtn = document.getElementById('leave-btn');
if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to leave the chat?')) {
      window.location.href = '../index.html';
    }
  });
}
