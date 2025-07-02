const chatForm = document.getElementById('chat-form');
const chatMessages = document.getElementById('chat-messages');
const roomName = document.getElementById('room-name');
const userList = document.getElementById('users');
const emojiBtn = document.getElementById('emoji-btn');
const msgInput = document.getElementById('msg');
const typingIndicator = document.getElementById('typing-indicator'); // ✅ new

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

// Receive message
socket.on('message', (message) => {
  outputMessage(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// ✅ Show typing message
socket.on('showTyping', ({ username: typer }) => {
  if (typer !== username) {
    typingIndicator.innerText = `${typer} is typing...`;
    clearTimeout(typingIndicator.timeout);
    typingIndicator.timeout = setTimeout(() => {
      typingIndicator.innerText = '';
    }, 1500);
  }
});

// Send message
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = msgInput.value.trim();
  if (!msg) return;

  socket.emit('chatMessage', msg);
  msgInput.value = '';
  msgInput.focus();
  typingIndicator.innerText = '';
});

// ✅ Emit typing when typing
msgInput.addEventListener('input', () => {
  socket.emit('typing', { username, room });
});

// Output message to DOM
function outputMessage({ username: sender, text, time }) {
  const div = document.createElement('div');
  div.classList.add('message');

  if (sender === 'ChatApp Bot') {
    div.classList.add('bot');
  } else if (sender === username) {
    div.classList.add('you');
  } else {
    div.classList.add('other');
  }

  div.innerHTML = `
    <div class="meta fw-semibold">
      ${sender} <span class="text-muted small ms-2">${time}</span>
    </div>
    <div class="text">${text}</div>
  `;

  chatMessages.appendChild(div);
}

// Set room name
function outputRoomName(room) {
  if (roomName) roomName.innerText = room;
}

// List users
function outputUsers(users) {
  if (!userList) return;
  userList.innerHTML = '';
  users.forEach(({ username }) => {
    const li = document.createElement('li');
    li.className = 'list-group-item';
    li.textContent = username;
    userList.appendChild(li);
  });
}

// Leave Chat
const leaveBtn = document.getElementById('leave-btn');
if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to leave the chat?')) {
      window.location.href = '../index.html';
    }
  });
}

// ✅ Emoji Picker Integration (No Blinking)
const picker = new EmojiButton({
  position: 'top-start',
  theme: document.body.classList.contains('dark') ? 'dark' : 'light',
});

emojiBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  picker.togglePicker(emojiBtn);
});

picker.on('emoji', emoji => {
  msgInput.value += emoji;
  msgInput.focus();
});
