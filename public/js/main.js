// main.js - Complete Working Version
const socket = io();
const msgInput = document.getElementById('msg');
const chatMessages = document.getElementById('chat-messages');
const replyPreview = document.getElementById('reply-preview');
const replyUserElem = document.getElementById('reply-user');
const replyTextElem = document.getElementById('reply-text');
const cancelReplyBtn = document.getElementById('cancel-reply');
const themeBtn = document.getElementById('theme-toggle');
const muteBtn = document.getElementById('mute-toggle');
const notificationSound = new Audio('/sounds/notification.mp3');
const roomNameElem = document.getElementById('room-name');

const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });
let replyTo = null, isMuted = localStorage.getItem('isMuted') === 'true';
const typingUsers = new Set();
let typingIndicator = null;
let lastTypingUpdate = 0;

// Set room name in header
roomNameElem.textContent = room;

// Initialize dark mode
function initDarkMode() {
  const isDark = localStorage.getItem('darkMode') === 'true';
  document.body.classList.toggle('dark', isDark);
  const icon = themeBtn.querySelector('i');
  icon.classList.toggle('fa-moon', !isDark);
  icon.classList.toggle('fa-sun', isDark);
}

// Scroll to bottom of chat
function scrollToBottom(force = false) {
  const messages = chatMessages;
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 200;
  
  if (force || nearBottom) {
    messages.scrollTo({
      top: messages.scrollHeight,
      behavior: 'smooth'
    });
  }
  markMessagesAsSeen();
}

// Swipe to reply functionality
let touchStartX = 0;
let currentSwipedMessage = null;

function setupSwipeHandler(messageElement) {
  messageElement.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    currentSwipedMessage = messageElement;
  }, { passive: true });

  messageElement.addEventListener('touchmove', (e) => {
    if (!currentSwipedMessage) return;
    const diff = e.touches[0].clientX - touchStartX;
    
    if (diff > 0 && diff < 100) {
      e.preventDefault();
      messageElement.style.transform = `translateX(${diff}px)`;
    }
  }, { passive: false });

  messageElement.addEventListener('touchend', (e) => {
    if (!currentSwipedMessage) return;
    const diff = e.changedTouches[0].clientX - touchStartX;
    
    if (diff > 60) {
      const msgId = messageElement.id;
      const username = messageElement.querySelector('.meta strong').textContent;
      const text = messageElement.querySelector('.text').textContent;
      setupReply(username, msgId, text);
    }
    
    messageElement.style.transform = '';
    currentSwipedMessage = null;
  }, { passive: true });
}

// Add message to chat
function addMessage(msg) {
  if (typingIndicator) {
    typingIndicator.remove();
    typingIndicator = null;
  }
  
  const div = document.createElement('div');
  const isWelcomeMsg = msg.username === 'ChatApp Bot' && chatMessages.children.length === 0;
  div.className = `message ${msg.username === username ? 'you' : 'other'} ${isWelcomeMsg ? 'welcome-message' : ''}`;
  div.id = msg.id;

  let messageContent = '';
  
  // Add reply preview if exists
  if (msg.replyTo) {
    messageContent += `
      <div class="message-reply">
        <div class="reply-indicator">
          <div class="reply-line"></div>
          <div class="reply-content">
            <div class="reply-sender">${msg.replyTo.username} :&nbsp;</div>
            <div class="reply-text">${msg.replyTo.text}</div>
          </div>
        </div>
      </div>
    `;
  }

  // Add main message content
  messageContent += `
    <div class="meta"><strong>${msg.username}</strong> @ ${msg.time}</div>
    <div class="text">${msg.text}</div>
  `;

  // Add seen status for your messages
  if (msg.username === username) {
    let seenStatus = '';
    if (msg.seenBy && msg.seenBy.length > 0) {
      const seenNames = msg.seenBy.map(u => u === username ? 'You' : u).join(', ');
      seenStatus = `
        <div class="message-status">
          <span class="time">${msg.time}</span>
          <span class="seen">
            <span class="seen-icon">✔✔</span>
            <span class="seen-users" title="Seen by ${seenNames}">${seenNames}</span>
          </span>
        </div>
      `;
    } else {
      seenStatus = `
        <div class="message-status">
          <span class="time">${msg.time}</span>
          <span class="seen-icon">✔</span>
        </div>
      `;
    }
    messageContent += seenStatus;
  }

  div.innerHTML = messageContent;
  setupSwipeHandler(div);
  chatMessages.appendChild(div);
  setTimeout(() => scrollToBottom(true), 50);
}

// Setup reply functionality
function setupReply(username, msgID, text) {
  replyTo = { id: msgID, username, text };
  replyUserElem.textContent = username;
  replyTextElem.textContent = text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();
  if (navigator.vibrate) navigator.vibrate(50);
}

// Show typing indicator
function showTypingIndicator(username) {
  if (typingIndicator) {
    typingIndicator.remove();
  }
  
  typingIndicator = document.createElement('div');
  typingIndicator.className = 'message typing-indicator other';
  typingIndicator.innerHTML = `
    <div class="dots">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </div>
    <span class="typing-text">${username} is typing...</span>
  `;
  
  chatMessages.appendChild(typingIndicator);
  scrollToBottom(true);
}

// Hide typing indicator
function hideTypingIndicator() {
  if (typingIndicator) {
    typingIndicator.remove();
    typingIndicator = null;
  }
}

// Mark messages as seen
function markMessagesAsSeen() {
  const messages = Array.from(chatMessages.querySelectorAll('.message.you'))
    .map(el => el.id)
    .filter(id => id);
    
  if (messages.length > 0) {
    socket.emit('markAsSeen', { 
      messageIds: messages,
      room: room 
    });
  }
}

// Keyboard handling
function setupKeyboardHandling() {
  let lastHeight = window.innerHeight;
  
  window.addEventListener('resize', () => {
    const newHeight = window.innerHeight;
    if (newHeight < lastHeight) {
      setTimeout(scrollToBottom, 100);
    }
    lastHeight = newHeight;
  });

  msgInput.addEventListener('focus', () => setTimeout(scrollToBottom, 300));
}

// Event Listeners
document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const txt = msgInput.value.trim();
  if (!txt) return;
  
  socket.emit('chatMessage', { 
    text: txt, 
    replyTo: replyTo ? { 
      id: replyTo.id, 
      username: replyTo.username, 
      text: replyTo.text 
    } : null,
    room: room
  });
  
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
});

cancelReplyBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  replyTo = null;
  replyPreview.classList.add('d-none');
});

themeBtn.addEventListener('click', () => {
  const isDark = !document.body.classList.contains('dark');
  document.body.classList.toggle('dark', isDark);
  localStorage.setItem('darkMode', isDark);
  const icon = themeBtn.querySelector('i');
  icon.classList.toggle('fa-moon', !isDark);
  icon.classList.toggle('fa-sun', isDark);
});

muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('isMuted', isMuted);
  const icon = muteBtn.querySelector('i');
  icon.classList.toggle('fa-bell');
  icon.classList.toggle('fa-bell-slash');
  
  if (isMuted) {
    notificationSound.pause();
    notificationSound.currentTime = 0;
  }
});

// Typing detection
let typingTimeout;
msgInput.addEventListener('input', () => {
  const now = Date.now();
  if (now - lastTypingUpdate > 1000) {
    socket.emit('typing', { room });
    lastTypingUpdate = now;
  }
  
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit('stopTyping', { room });
  }, 2000);
});

// Visibility change handler
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    markMessagesAsSeen();
  }
});

// Initialize
initDarkMode();
setupKeyboardHandling();
scrollToBottom(true);

// Socket.io Event Handlers
socket.on('connect', () => {
  socket.emit('joinRoom', { username, room });
});

socket.on('message', (msg) => {
  if (msg.username !== username && msg.username !== 'ChatApp Bot' && !isMuted) {
    notificationSound.play().catch(() => {});
  }
  addMessage(msg);
  hideTypingIndicator();
});

socket.on('userJoined', (msg) => {
  addMessage({
    id: 'system-msg-' + Date.now(),
    username: 'ChatApp Bot',
    text: `${msg.username} has joined the chat`,
    time: msg.time
  });
});

socket.on('userLeft', (msg) => {
  addMessage({
    id: 'system-msg-' + Date.now(),
    username: 'ChatApp Bot',
    text: `${msg.username} has left the chat`,
    time: msg.time
  });
});

socket.on('showTyping', ({ username: u }) => {
  if (u !== username) {
    typingUsers.add(u);
    showTypingIndicator(u);
  }
});

socket.on('stopTyping', ({ username: u }) => {
  typingUsers.delete(u);
  if (typingUsers.size === 0) {
    hideTypingIndicator();
  } else {
    showTypingIndicator([...typingUsers][typingUsers.size - 1]);
  }
});

socket.on('messagesSeen', (updates) => {
  updates.forEach(update => {
    const message = document.getElementById(update.messageId);
    if (message) {
      const seenUsersEl = message.querySelector('.seen-users');
      if (seenUsersEl) {
        const seenNames = update.seenBy.map(u => u === username ? 'You' : u).join(', ');
        seenUsersEl.textContent = seenNames;
        seenUsersEl.title = `Seen by ${seenNames}`;
      } else {
        const seenEl = message.querySelector('.seen');
        if (seenEl) {
          const seenNames = update.seenBy.map(u => u === username ? 'You' : u).join(', ');
          seenEl.innerHTML += `<span class="seen-users" title="Seen by ${seenNames}">${seenNames}</span>`;
        }
      }
    }
  });
});

// iOS-specific fixes
if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
  window.addEventListener('resize', () => {
    document.querySelector('header').style.position = 'sticky';
  });
}