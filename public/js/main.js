const socket = io();
const chatForm = document.getElementById('chat-form');
const chatMessages = document.getElementById('chat-messages');
const msgInput = document.getElementById('msg');
const replyPreview = document.getElementById('reply-preview');
const replyUser = document.getElementById('reply-user');
const replyText = document.getElementById('reply-text');
const cancelReplyBtn = document.getElementById('cancel-reply');
const roomName = document.getElementById('room-name');
const roomHeader = document.getElementById('room-header');
const usersList = document.getElementById('users');

const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });

let replyTo = null;
const messageMap = new Map();
const typingMap = new Map();
let isMuted = false;

// Join the room
socket.emit('joinRoom', { username, room });

// Update room UI
socket.on('roomUsers', ({ room, users }) => {
  if (roomName) roomName.textContent = room;
  if (roomHeader) roomHeader.textContent = room;
  if (usersList) {
    usersList.innerHTML = users.map(u => `<li>${u.username}</li>`).join('');
  }
});

// Sound
const notificationSound = new Audio('/sounds/notification.mp3');
document.body.addEventListener('click', () => {
  notificationSound.play().catch(() => { });
}, { once: true });

// Handle incoming messages
socket.on('message', (message) => {
  if (message.username !== username && !isMuted) {
    notificationSound.play().catch(() => {});
  }
  removeTypingIndicator(message.username);
  outputMessage(message);
  autoScroll();
});

// Typing indicator
socket.on('showTyping', ({ username: sender }) => {
  if (sender !== username) {
    showTypingIndicator(sender);
  }
});

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

// Show typing
function showTypingIndicator(sender) {
  if (typingMap.has(sender)) return;

  const div = document.createElement('div');
  div.classList.add('message', 'typing');
  div.dataset.user = sender;
  div.innerHTML = `
    <div class="meta"><strong>${sender}</strong> <span>typing...</span></div>
    <div class="text d-flex gap-1">
      <div class="dot"></div>
      <div class="dot"></div>
      <div class="dot"></div>
    </div>
  `;

  chatMessages.appendChild(div);
  autoScroll();
  typingMap.set(sender, div);

  setTimeout(() => {
    removeTypingIndicator(sender);
  }, 3500);
}

function removeTypingIndicator(sender) {
  const el = typingMap.get(sender);
  if (el) {
    el.remove();
    typingMap.delete(sender);
  }
}

// Send message
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

// Typing event
msgInput.addEventListener('input', () => {
  socket.emit('typing');
});

// Reply
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

function scrollToAndHighlight(id) {
  const el = messageMap.get(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight-reply');
  setTimeout(() => el.classList.remove('highlight-reply'), 2000);
}

function autoScroll() {
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

// iOS Safari Keyboard Visual Viewport Fix
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const vh = window.visualViewport.height;
    document.documentElement.style.setProperty('--safe-vh', `${vh}px`);
  });
}

// Handle sticky header
msgInput.addEventListener('focus', () => {
  setTimeout(() => {
    msgInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 300);
});

// Toggle mute
document.getElementById('mute-toggle')?.addEventListener('click', () => {
  const icon = document.getElementById('mute-icon');
  isMuted = !isMuted;
  icon.classList.toggle('fa-bell');
  icon.classList.toggle('fa-bell-slash');
});

// Toggle theme
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const body = document.body;
  const icon = document.getElementById('theme-icon');
  body.classList.toggle('dark');
  icon.classList.toggle('fa-moon');
  icon.classList.toggle('fa-sun');
});
