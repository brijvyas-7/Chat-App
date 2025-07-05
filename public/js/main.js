const notificationSound = new Audio('/sounds/notification.mp3');
const chatForm = document.getElementById('chat-form');
chatMessages = document.getElementById('chat-messages');
const roomName = document.getElementById('room-name');
const userList = document.getElementById('users');
const emojiBtn = document.getElementById('emoji-btn');
const msgInput = document.getElementById('msg');
const typingIndicator = document.getElementById('typing-indicator');
const muteToggle = document.getElementById('mute-toggle');
const muteIcon = document.getElementById('mute-icon');

// Parse username and room
const { username, room } = Qs.parse(location.search, {
  ignoreQueryPrefix: true,
});

// Setup socket
const socket = io();

// Mute preference
let isMuted = localStorage.getItem('muted') === 'true';
updateMuteIcon();

muteToggle.addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('muted', isMuted);
  updateMuteIcon();
});

function updateMuteIcon() {
  if (isMuted) {
    muteIcon.classList.remove('fa-bell');
    muteIcon.classList.add('fa-bell-slash');
  } else {
    muteIcon.classList.remove('fa-bell-slash');
    muteIcon.classList.add('fa-bell');
  }
}

// Join room
socket.emit('joinRoom', { username, room });

// Update room and users
socket.on('roomUsers', ({ room, users }) => {
  outputRoomName(room);
  outputUsers(users);
});

// Message received
socket.on('message', (message) => {
  outputMessage(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Play notification if not muted and not own message
  if (message.username !== username && message.username !== 'ChatApp Bot' && !isMuted) {
    notificationSound.play();
  }
});

// Typing indicator
socket.on('showTyping', ({ username: typer }) => {
  if (typer !== username) {
    typingIndicator.innerText = `${typer} is typing...`;
    clearTimeout(typingIndicator.timeout);
    typingIndicator.timeout = setTimeout(() => {
      typingIndicator.innerText = '';
    }, 1500);
  }
});

// Typing event
msgInput.addEventListener('input', () => {
  socket.emit('typing', { username, room });
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

// Display message
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

// Output room name
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

// Leave chat
const leaveBtn = document.getElementById('leave-btn');
if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to leave the chat?')) {
      window.location.href = '../index.html';
    }
  });
}

// Emoji picker
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

let typingTimeout;

msgInput.addEventListener('input', () => {
  socket.emit('typing');

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit('stopTyping');
  }, 1500);
});

socket.on('showTyping', (username) => {
  typingIndicator.innerText = `${username} is typing...`;
  typingIndicator.style.display = 'block';
});

socket.on('hideTyping', () => {
  typingIndicator.innerText = '';
  typingIndicator.style.display = 'none';
});

