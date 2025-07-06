const pendingReplies = new Map();
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
const messageMap = new Map();

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

  socket.emit('chatMessage', {
    text: msg,
    replyTo: replyTo ? { ...replyTo } : null
  });

  msgInput.value = '';
  msgInput.focus();
  replyTo = null;
  replyUser.textContent = '';
  replyText.textContent = '';
  replyPreview.style.display = 'none';

  if (typingBubble instanceof Element) typingBubble.remove();
  typingBubble = null;
});

function scrollToAndHighlight(messageId) {
  const el = messageMap.get(messageId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight-reply');
  setTimeout(() => {
    el.classList.remove('highlight-reply');
  }, 2000);
}

function outputMessage({ id, username: sender, text, time, replyTo: replyData }) {
  const div = document.createElement('div');
  div.classList.add('message');
  div.dataset.id = id;

  if (sender === 'ChatApp Bot') {
    div.classList.add('bot');
  } else if (sender === username) {
    div.classList.add('you');
  } else {
    div.classList.add('other');
  }

  let replyHTML = '';
  if (replyData) {
    replyHTML = `
      <div class="reply-box" data-target="${replyData.id}" style="cursor:pointer">
        <div class="reply-username"><b>${replyData.username}</b></div>
        <div class="reply-text">${replyData.text.length > 50 ? replyData.text.substring(0, 50) + '…' : replyData.text}</div>
      </div>
    `;
  }

  div.innerHTML = `
    ${replyHTML}
    <div class="meta fw-semibold">
      ${sender} <span class="text-muted small ms-2">${time}</span>
    </div>
    <div class="text">${text}</div>
  `;

  if (replyData) {
    div.querySelector('.reply-box')?.addEventListener('click', () => scrollToAndHighlight(replyData.id));
  }

  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    replyTo = { username: sender, text, id };
    replyUser.textContent = sender;
    replyText.textContent = text;
    replyPreview.style.display = 'block';
  });

  let startX = 0;
  let swiping = false;

  div.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
  });

  div.addEventListener('touchmove', (e) => {
    const currentX = e.touches[0].clientX;
    if (currentX - startX > 60 && !swiping) {
      swiping = true;
      replyTo = { username: sender, text, id };
      replyUser.textContent = sender;
      replyText.textContent = text;
      replyPreview.style.display = 'block';
    }
  });

  div.addEventListener('touchend', () => {
    swiping = false;
  });

  chatMessages.appendChild(div);
  messageMap.set(id, div);

  if (replyData?.id) {
    if (messageMap.has(replyData.id)) {
      const original = messageMap.get(replyData.id);
      if (!original.querySelector('.reply-tag')) {
        const tag = document.createElement('div');
        tag.className = 'reply-tag text-muted small';
        tag.innerHTML = `🔁 Replied by <b>${sender}</b>`;
        original.appendChild(tag);
      }
      original.classList.add('has-reply');
    } else {
      if (!pendingReplies.has(replyData.id)) {
        pendingReplies.set(replyData.id, []);
      }
      pendingReplies.get(replyData.id).push(sender);
    }
  }

  if (pendingReplies.has(id)) {
    const senders = pendingReplies.get(id);
    for (const s of senders) {
      const tag = document.createElement('div');
      tag.className = 'reply-tag text-muted small';
      tag.innerHTML = `🔁 Replied by <b>${s}</b>`;
      div.appendChild(tag);
      div.classList.add('has-reply');
    }
    pendingReplies.delete(id);
  }
}

cancelReplyBtn.addEventListener('click', () => {
  replyTo = null;
  replyUser.textContent = '';
  replyText.textContent = '';
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then(reg => console.log('✅ Service Worker registered'))
      .catch(err => console.error('❌ Service Worker failed', err));
  });
}
