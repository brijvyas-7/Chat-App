// main.js — Clean, Fully Working Version

const notificationSound = new Audio('/sounds/notification.mp3');
const socket = io();

const chatForm = document.getElementById('chat-form');
const chatMessages = document.getElementById('chat-messages');
const roomName = document.getElementById('room-name');
const userList = document.getElementById('users');
const msgInput = document.getElementById('msg');
const muteToggle = document.getElementById('mute-toggle');
const muteIcon = document.getElementById('mute-icon');
const replyPreview = document.getElementById('reply-preview');
const replyUser = document.getElementById('reply-user');
const replyText = document.getElementById('reply-text');
const cancelReplyBtn = document.getElementById('cancel-reply');
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');

const { username, room } = Qs.parse(location.search, {
  ignoreQueryPrefix: true,
});

let isMuted = localStorage.getItem('muted') === 'true';
let isDark = localStorage.getItem('theme') === 'dark';
let replyTo = null;
const messageMap = new Map();

// ========== INIT UI SETTINGS ==========
if (isDark) {
  document.body.classList.add('dark');
  themeIcon.classList.replace('fa-moon', 'fa-sun');
}
updateMuteIcon();

function updateMuteIcon() {
  muteIcon.classList.toggle('fa-bell-slash', isMuted);
  muteIcon.classList.toggle('fa-bell', !isMuted);
}

// ========== EVENT: Toggle Mute ==========
muteToggle?.addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('muted', isMuted);
  updateMuteIcon();
});

// ========== EVENT: Toggle Theme ==========
themeToggle?.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  isDark = document.body.classList.contains('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  themeIcon.classList.replace(isDark ? 'fa-moon' : 'fa-sun', isDark ? 'fa-sun' : 'fa-moon');
});

// ========== SOCKET EVENTS ==========
socket.emit('joinRoom', { username, room });

socket.on('roomUsers', ({ room, users }) => {
  roomName.textContent = room;
  userList.innerHTML = users.map(u => `<li>${u.username}</li>`).join('');
});

socket.on('message', (message) => {
  outputMessage(message);

  setTimeout(() => autoScroll(), 50);

  if (
    message.username !== username &&
    message.username !== 'ChatApp Bot' &&
    !isMuted
  ) {
    notificationSound.play();
  }
});

socket.on('showTyping', ({ username: typer }) => {
  if (typer === username) return;
  showTypingBubble(typer);
});

socket.on('hideTyping', hideTypingBubble);

// ========== TYPING HANDLING ==========
let typingTimeout;
msgInput.addEventListener('input', () => {
  socket.emit('typing');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('stopTyping'), 1200);
});

// ========== FORM SUBMIT ==========
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = msgInput.value.trim();
  if (!msg) return;

  socket.emit('chatMessage', {
    text: msg,
    replyTo: replyTo ? { ...replyTo } : null,
  });

  msgInput.value = '';
  msgInput.focus();
  replyTo = null;
  hideReplyPreview();
});

// ========== UI FUNCTIONS ==========
function outputMessage({ id, username: sender, text, time, replyTo: replyData }) {
  const div = document.createElement('div');
  div.classList.add('message', sender === username ? 'you' : sender === 'ChatApp Bot' ? 'bot' : 'other');
  div.dataset.id = id;

  let replyHTML = '';
  if (replyData) {
    replyHTML = `
      <div class="reply-box" data-target="${replyData.id}" style="cursor:pointer">
        <div class="reply-username fw-bold">${replyData.username}</div>
        <div class="reply-text small">${replyData.text.substring(0, 60)}${replyData.text.length > 60 ? '…' : ''}</div>
      </div>
    `;
  }

  div.innerHTML = `
    ${replyHTML}
    <div class="meta small text-muted">
      <strong>${sender}</strong> <span class="ms-2">${time}</span>
    </div>
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
  div.addEventListener('touchstart', (e) => startX = e.touches[0].clientX);
  div.addEventListener('touchend', (e) => {
    if (e.changedTouches[0].clientX - startX > 60) {
      setReply({ id, username: sender, text });
    }
  });

  chatMessages.appendChild(div);
  messageMap.set(id, div);
}

function setReply({ id, username, text }) {
  replyTo = { id, username, text };
  replyUser.textContent = username;
  replyText.textContent = text;
  replyPreview.classList.remove('d-none');
  replyPreview.scrollIntoView({ behavior: 'smooth', block: 'end' });
  msgInput.focus();
}

cancelReplyBtn.addEventListener('click', hideReplyPreview);

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
    const lastMsg = chatMessages.lastElementChild;
    if (!lastMsg) return;
    lastMsg.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
  });
}

let typingBubble;
function showTypingBubble(user) {
  if (typingBubble) typingBubble.remove();
  typingBubble = document.createElement('div');
  typingBubble.className = 'message typing other';
  typingBubble.innerHTML = `
    <div class="meta small fw-semibold">${user}</div>
    <div class="text"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  `;
  chatMessages.appendChild(typingBubble);
  autoScroll();
}

function hideTypingBubble() {
  if (typingBubble) typingBubble.remove();
  typingBubble = null;
}

msgInput.addEventListener('focus', () => {
  setTimeout(() => msgInput.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then(() => console.log('✅ Service Worker registered'))
      .catch(err => console.error('❌ SW registration failed', err));
  });
}
