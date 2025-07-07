const socket = io();

// DOM Elements
const chatForm = document.getElementById('chat-form');
const chatMessages = document.getElementById('chat-messages');
const msgInput = document.getElementById('msg');
const replyPreview = document.getElementById('reply-preview');
const replyUser = document.getElementById('reply-user');
const replyText = document.getElementById('reply-text');
const cancelReplyBtn = document.getElementById('cancel-reply');
const roomNameEl = document.getElementById('room-name'); // Renamed to avoid conflict
const usersList = document.getElementById('users');

const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });

let replyTo = null;
const messageMap = new Map();

// Join room
socket.emit('joinRoom', { username, room });

// Update room name and users list
socket.on('roomUsers', ({ room, users }) => {
  if (roomNameEl) roomNameEl.textContent = room;
  if (usersList) {
    usersList.innerHTML = users.map(user => `<li>${user.username}</li>`).join('');
  }
});

// Handle incoming messages
socket.on('message', (message) => {
  outputMessage(message);
  autoScroll();
});

// Render a message
function outputMessage({ id, username: sender, text, time, replyTo: replyData }) {
  const div = document.createElement('div');
  div.classList.add('message', sender === username ? 'you' : sender === 'ChatApp Bot' ? 'bot' : 'other');
  div.dataset.id = id;

  let replyHTML = '';
  if (replyData) {
    replyHTML = `
      <div class="reply-box" data-target="${replyData.id}">
        <div class="reply-username"><strong>${replyData.username}</strong></div>
        <div class="reply-text">${replyData.text}</div>
      </div>
    `;
  }

  div.innerHTML = `
    ${replyHTML}
    <div class="meta"><strong>${sender}</strong> <span>${time}</span></div>
    <div class="text">${text}</div>
  `;

  if (replyData) {
    div.querySelector('.reply-box')?.addEventListener('click', () => scrollToAndHighlight(replyData.id));
  }

  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setReply({ id, username: sender, text });
  });

  let startX = 0;
  div.addEventListener('touchstart', (e) => (startX = e.touches[0].clientX));
  div.addEventListener('touchend', (e) => {
    if (e.changedTouches[0].clientX - startX > 50) {
      setReply({ id, username: sender, text });
    }
  });

  chatMessages.appendChild(div);
  messageMap.set(id, div);
}

// Submit message
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = msgInput.value.trim();
  if (!msg) return;

  socket.emit('chatMessage', {
    text: msg,
    replyTo: replyTo ? { ...replyTo } : null,
  });

  msgInput.value = '';
  replyTo = null;
  hideReplyPreview();
});

// Set reply state
function setReply({ id, username, text }) {
  replyTo = { id, username, text };
  replyUser.textContent = username;
  replyText.textContent = text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();
  replyPreview.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

cancelReplyBtn?.addEventListener('click', hideReplyPreview);

function hideReplyPreview() {
  replyTo = null;
  replyUser.textContent = '';
  replyText.textContent = '';
  replyPreview.classList.add('d-none');
}

// Scroll to replied message and highlight
function scrollToAndHighlight(id) {
  const el = messageMap.get(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight-reply');
  setTimeout(() => el.classList.remove('highlight-reply'), 2000);
}

// Auto-scroll on new message
function autoScroll() {
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}


// iOS scroll fix
msgInput.addEventListener('focus', () => {
  setTimeout(() => {
    msgInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 300);
});

// Mute toggle
document.getElementById('mute-toggle')?.addEventListener('click', () => {
  const icon = document.getElementById('mute-icon');
  icon.classList.toggle('fa-bell');
  icon.classList.toggle('fa-bell-slash');
});

// Theme toggle
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const body = document.body;
  const icon = document.getElementById('theme-icon');
  body.classList.toggle('dark');
  icon.classList.toggle('fa-moon');
  icon.classList.toggle('fa-sun');
});
