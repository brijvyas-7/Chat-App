const socket = io();
const chatForm = document.getElementById('chat-form');
const chatMessages = document.getElementById('chat-messages');
const msgInput = document.getElementById('msg');
const typingIndicator = document.getElementById('typing-indicator');
const replyPreview = document.getElementById('reply-preview');
const replyUser = document.getElementById('reply-user');
const replyText = document.getElementById('reply-text');
const cancelReply = document.getElementById('cancel-reply');
const themeBtn = document.getElementById('theme-toggle');
const muteBtn = document.getElementById('mute-toggle');

const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });
let replyTo = null, isMuted = false;
const typingUsers = new Set();

// Join room
socket.emit('joinRoom', { username, room });

// Utility: check if user is near bottom
function isUserNearBottom() {
  const threshold = 100;
  return (
    chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight
    < threshold
  );
}

// Robust scroll-to-bottom
function scrollToBottom(force = false) {
  if (force || isUserNearBottom()) {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }
}

// Incoming messages
socket.on('message', msg => {
  if (msg.username !== username && !isMuted) {
    new Audio('/sounds/notification.mp3').play().catch(() => {});
  }
  addMessage(msg);
});

// Typing indicator from others
socket.on('showTyping', ({ username: u }) => {
  if (u !== username && !typingUsers.has(u)) {
    typingUsers.add(u);
    typingIndicator.querySelector('#typing-user').textContent = u;
    typingIndicator.classList.remove('d-none');
    chatMessages.appendChild(typingIndicator);
    scrollToBottom();
    setTimeout(() => {
      typingUsers.delete(u);
      if (!typingUsers.size) typingIndicator.classList.add('d-none');
    }, 1500);
  }
});

// Add new message and auto-scroll
function addMessage({ id, username: u, text, time, replyTo: r }) {
  typingIndicator.classList.add('d-none');

  const div = document.createElement('div');
  div.className = 'message ' + (u === username ? 'you' : 'other');
  div.id = id;

  if (r) {
    const replyBox = document.createElement('div');
    replyBox.className = 'reply-box';
    replyBox.innerHTML = `<strong>${r.username}</strong>: ${r.text}`;
    replyBox.addEventListener('click', () => {
      const target = document.getElementById(r.id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    div.appendChild(replyBox);
  }

  div.innerHTML += `
    <div class="meta"><strong>${u}</strong> @ ${time}</div>
    <div class="text">${text}</div>
  `;

  // Swipe to reply
  let startX = 0;
  div.addEventListener('touchstart', e => startX = e.touches[0].clientX);
  div.addEventListener('touchend', e => {
    if (e.changedTouches[0].clientX - startX > 60) setReply({ id, username: u, text });
  });

  // Right-click reply
  div.addEventListener('contextmenu', e => { e.preventDefault(); setReply({ id, username: u, text }); });

  chatMessages.appendChild(div);
  scrollToBottom();
}

// Send new message
chatForm.addEventListener('submit', e => {
  e.preventDefault();
  const txt = msgInput.value.trim();
  if (!txt) return;
  socket.emit('chatMessage', { text: txt, replyTo: replyTo ? { ...replyTo } : null });
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
});

// Reply setup
function setReply(msg) {
  replyTo = msg;
  replyUser.textContent = msg.username;
  replyText.textContent = msg.text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();
}
cancelReply.addEventListener('click', () => {
  replyTo = null;
  replyPreview.classList.add('d-none');
});

// Typing: emit to others
msgInput.addEventListener('input', () => {
  socket.emit('typing');
});

// Scroll on focus (force)
msgInput.addEventListener('focus', () => {
  setTimeout(() => scrollToBottom(true), 200);
});

// Theme & mute toggles
themeBtn.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  themeBtn.querySelector('i').classList.toggle('fa-moon');
  themeBtn.querySelector('i').classList.toggle('fa-sun');
});
muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  muteBtn.querySelector('i').classList.toggle('fa-bell-slash');
});
