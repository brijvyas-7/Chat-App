const notificationSound = new Audio('/sounds/notification.mp3');
const chatForm = document.getElementById('chat-form');
const chatMessages = document.getElementById('chat-messages');
const roomName = document.getElementById('room-name');
const userList = document.getElementById('users');
const emojiBtn = document.getElementById('emoji-btn');
const msgInput = document.getElementById('msg');
const muteToggle = document.getElementById('mute-toggle');
const muteIcon = document.getElementById('mute-icon');
const replyPreview = document.getElementById('reply-preview');
const replyUser = document.getElementById('reply-user');
const replyText = document.getElementById('reply-text');
const cancelReplyBtn = document.getElementById('cancel-reply');

let replyTo = null;

// Parse username and room
const { username, room } = Qs.parse(location.search, {
  ignoreQueryPrefix: true,
});

const socket = io();

let isMuted = localStorage.getItem('muted') === 'true';
updateMuteIcon();

muteToggle.addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('muted', isMuted);
  updateMuteIcon();
});

function updateMuteIcon() {
  muteIcon.classList.toggle('fa-bell', !isMuted);
  muteIcon.classList.toggle('fa-bell-slash', isMuted);
}

socket.emit('joinRoom', { username, room });

socket.on('roomUsers', ({ room, users }) => {
  outputRoomName(room);
  outputUsers(users);
});

socket.on('message', (message) => {
  outputMessage(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (message.username !== username && message.username !== 'ChatApp Bot' && !isMuted) {
    notificationSound.play();
  }
});

let typingBubble = null;

socket.on('showTyping', ({ username: typer }) => {
  if (typer === username) return;

  if (typingBubble instanceof Element) typingBubble.remove();

  typingBubble = document.createElement('div');
  typingBubble.classList.add('message', 'typing', 'other');
  typingBubble.innerHTML = `
    <div class="meta fw-semibold">${typer}</div>
    <div class="text"><span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div>
  `;
  chatMessages.appendChild(typingBubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  clearTimeout(typingBubble?.timeout);
  typingBubble.timeout = setTimeout(() => {
    if (typingBubble instanceof Element) typingBubble.remove();
    typingBubble = null;
  }, 1500);
});

socket.on('hideTyping', () => {
  if (typingBubble instanceof Element) typingBubble.remove();
  typingBubble = null;
});

let typingTimeout;
msgInput.addEventListener('input', () => {
  socket.emit('typing', { username, room });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit('stopTyping');
  }, 1500);
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = msgInput.value.trim();
  if (!msg) return;

  socket.emit('chatMessage', { text: msg, replyTo });
  msgInput.value = '';
  msgInput.focus();
  replyTo = null;
  replyPreview.style.display = 'none';

  if (typingBubble instanceof Element) typingBubble.remove();
  typingBubble = null;
});

function outputMessage({ username: sender, text, time, replyTo }) {
  const div = document.createElement('div');
  div.classList.add('message');

  if (sender === 'ChatApp Bot') {
    div.classList.add('bot');
  } else if (sender === username) {
    div.classList.add('you');
  } else {
    div.classList.add('other');
  }

  let replyHTML = '';
  if (replyTo) {
    replyHTML = `<div class="reply-box"><b>${replyTo.username}:</b> ${replyTo.text}</div>`;
  }

  div.innerHTML = `
    <div class="meta fw-semibold">
      ${sender} <span class="text-muted small ms-2">${time}</span>
    </div>
    ${replyHTML}
    <div class="text">${text}</div>
  `;

  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    replyTo = { username: sender, text };
    replyUser.textContent = sender;
    replyText.textContent = text;
    replyPreview.style.display = 'block';
  });

  chatMessages.appendChild(div);
}

cancelReplyBtn.addEventListener('click', () => {
  replyTo = null;
  replyPreview.style.display = 'none';
});

function outputRoomName(room) {
  if (roomName) roomName.innerText = room;
}

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

const leaveBtn = document.getElementById('leave-btn');
if (leaveBtn) {
  leaveBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to leave the chat?')) {
      window.location.href = '../index.html';
    }
  });
}

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

document.addEventListener('DOMContentLoaded', () => {
  const themeToggle = document.getElementById('theme-toggle');
  const themeIcon = document.getElementById('theme-icon');

  if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark');
    themeIcon.classList.remove('fa-moon');
    themeIcon.classList.add('fa-sun');
  }

  themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    const isDark = document.body.classList.contains('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    themeIcon.classList.toggle('fa-moon', !isDark);
    themeIcon.classList.toggle('fa-sun', isDark);
  });

  scrollToBottom();
  const observer = new MutationObserver(scrollToBottom);
  observer.observe(chatMessages, { childList: true });

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});

const chatFormContainer = document.querySelector('.chat-form-container');

window.addEventListener('resize', () => {
  if (window.innerHeight < 500) {
    chatMessages.style.paddingBottom = '200px';
    window.scrollTo(0, document.body.scrollHeight);
  } else {
    chatMessages.style.paddingBottom = '90px';
  }
});

window.addEventListener('resize', () => {
  document.body.style.height = window.innerHeight + 'px';
});

function adjustForKeyboard() {
  const form = document.querySelector('.chat-form-container');
  if (window.innerHeight < 500) {
    form.style.position = 'absolute';
    form.style.bottom = '0';
  } else {
    form.style.position = 'fixed';
    form.style.bottom = '0';
  }
}

window.addEventListener('resize', adjustForKeyboard);
window.addEventListener('load', adjustForKeyboard);

let initialHeight = window.innerHeight;

window.addEventListener('resize', () => {
  const isKeyboard = window.innerHeight < initialHeight;
  document.body.classList.toggle('keyboard-open', isKeyboard);
});

function setViewportHeight() {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}

window.addEventListener('resize', setViewportHeight);
window.addEventListener('load', setViewportHeight);
window.addEventListener('orientationchange', setViewportHeight);
document.addEventListener('DOMContentLoaded', setViewportHeight);

const input = document.getElementById('msg');
input.addEventListener('focus', () => {
  setTimeout(() => {
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 300);
});

setVhUnit();
function setVhUnit() {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}
window.addEventListener('resize', setVhUnit);
window.addEventListener('orientationchange', setVhUnit);
