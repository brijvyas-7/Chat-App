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
let replyTo = null, isMuted = localStorage.getItem('isMuted') !== 'true';
const typingUsers = new Set();
let typingIndicator = null;
let lastTypingUpdate = 0;
let touchStartX = 0;
const SWIPE_THRESHOLD = 60;

// Set room name in header
roomNameElem.textContent = room;

// Initialize dark mode
function initDarkMode() {
  const isDark = localStorage.getItem('darkMode') === 'true';
  document.body.classList.toggle('dark', isDark);
  const icon = themeBtn.querySelector('i');
  icon.classList.toggle('fa-moon', !isDark);
  icon.classList.toggle('fa-sun', isDark);
  
  // Set dark mode background
  if (isDark) {
    document.querySelector('.chat-container').style.backgroundColor = 'var(--terminal-bg)';
    document.querySelector('.messages-container').style.backgroundColor = 'var(--terminal-bg)';
  }
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
function setupSwipeHandler(messageElement) {
  messageElement.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  messageElement.addEventListener('touchmove', (e) => {
    const diffX = e.touches[0].clientX - touchStartX;
    if (diffX > 0 && diffX < 100) {
      e.preventDefault();
      messageElement.style.transform = `translateX(${diffX}px)`;
    }
  }, { passive: false });

  messageElement.addEventListener('touchend', (e) => {
    const diffX = e.changedTouches[0].clientX - touchStartX;
    if (diffX > SWIPE_THRESHOLD) {
      const msgId = messageElement.id;
      const username = messageElement.querySelector('.meta strong').textContent;
      const text = messageElement.querySelector('.text').textContent;
      setupReply(username, msgId, text);
    }
    messageElement.style.transform = '';
  }, { passive: true });
}

// Initialize message handlers
function initMessageHandlers() {
  const messages = document.querySelectorAll('.message:not(.system)');
  messages.forEach(msg => {
    if (!document.body.classList.contains('dark')) {
      setupSwipeHandler(msg);
    }
  });
}

// Add message to chat
function addMessage(msg) {
  if (typingIndicator) {
    typingIndicator.remove();
    typingIndicator = null;
  }
  
  const div = document.createElement('div');
  const isSystemMsg = msg.username === 'ChatApp Bot';
  div.className = `message ${msg.username === username ? 'you' : 'other'} ${isSystemMsg ? 'system' : ''}`;
  div.id = msg.id;

  const isDark = document.body.classList.contains('dark');
  let messageContent = '';

  // Add reply preview if exists
  if (msg.replyTo) {
    if (isDark) {
      // Terminal-style reply indicator
      messageContent += `
        <div class="message-reply">
          <span class="reply-sender">${msg.replyTo.username}</span>
          <span class="reply-text">${msg.replyTo.text}</span>
        </div>
      `;
    } else {
      // WhatsApp-style reply indicator
      messageContent += `
        <div class="message-reply">
          <span class="reply-sender">${msg.replyTo.username}</span>
          <span class="reply-text">${msg.replyTo.text}</span>
        </div>
      `;
    }
  }

  if (isDark) {
    // Terminal-style message format
    messageContent += `
      <div class="meta">
        <span class="prompt-sign">${msg.username === username ? '>' : '$'}</span>
        <strong>${msg.username}</strong>
        <span class="message-time">${msg.time} :</span>
      </div>
      <div class="text">${msg.text}</div>
    `;
    
    if (msg.username === username) {
      const seenNames = msg.seenBy?.length > 0 
        ? msg.seenBy.map(u => u === username ? 'You' : u).join(', ')
        : '';
      
      messageContent += `
        <div class="message-status">
          <span class="seen-icon">${seenNames ? '✓✓' : '✓'}</span>
          ${seenNames ? `<span class="seen-users">${seenNames}</span>` : ''}
        </div>
      `;
    }
  } else {
    // WhatsApp-style format
    messageContent += `
      <div class="meta"><strong>${msg.username}</strong> <span class="message-time">${msg.time}</span></div>
      <div class="text">${msg.text}</div>
    `;
    
    if (msg.username === username) {
      const seenNames = msg.seenBy?.length > 0 
        ? msg.seenBy.map(u => u === username ? 'You' : u).join(', ')
        : '';
      
      messageContent += `
        <div class="message-status">
          <span class="seen-icon">${seenNames ? '✓✓' : '✓'}</span>
          ${seenNames ? `<span class="seen-users">${seenNames}</span>` : ''}
        </div>
      `;
    }
  }

  div.innerHTML = messageContent;
  
  if (!isDark) {
    setupSwipeHandler(div);
  }
  
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
  
  // Vibration feedback
  try {
    if (navigator.vibrate) navigator.vibrate(50);
  } catch (e) {
    console.log("Vibration not supported");
  }
  
  // Scroll to input
  setTimeout(() => {
    document.querySelector('.input-container').scrollIntoView({ behavior: 'smooth' });
  }, 100);
}

// Show typing indicator
function showTypingIndicator(username) {
  if (typingIndicator) {
    typingIndicator.remove();
    typingIndicator = null;
  }
  
  const isDark = document.body.classList.contains('dark');
  typingIndicator = document.createElement('div');
  typingIndicator.className = 'typing-indicator';
  
  if (isDark) {
    typingIndicator.innerHTML = `
      <span class="prompt-sign">$</span>
      <span class="typing-text">${username} is typing...</span>
    `;
  } else {
    typingIndicator.className += ' other';
    typingIndicator.innerHTML = `
      <div class="dots">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
      <span class="typing-text">${username} is typing...</span>
    `;
  }
  
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

// Fix input box width
function fixInputBox() {
  const inputForm = document.querySelector('.input-form');
  if (!document.body.classList.contains('dark')) {
    inputForm.style.maxWidth = '100%';
    inputForm.style.width = '100%';
  }
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
  
  // Update background colors for dark mode
  if (isDark) {
    document.querySelector('.chat-container').style.backgroundColor = 'var(--terminal-bg)';
    document.querySelector('.messages-container').style.backgroundColor = 'var(--terminal-bg)';
  } else {
    document.querySelector('.chat-container').style.backgroundColor = '';
    document.querySelector('.messages-container').style.backgroundColor = '';
  }
  
  fixInputBox();
  initMessageHandlers();
});

muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('isMuted', isMuted);
  const icon = muteBtn.querySelector('i');
  icon.classList.toggle('fa-bell', !isMuted);
  icon.classList.toggle('fa-bell-slash', isMuted);
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

// Initialize everything
initDarkMode();
setupKeyboardHandling();
scrollToBottom(true);
initMessageHandlers();
fixInputBox();

// Socket.io Event Handlers
socket.on('connect', () => {
  socket.emit('joinRoom', { username, room });
});

socket.on('message', (msg) => {
  if (msg.username !== username && msg.username !== 'ChatApp Bot' && !isMuted) {
    notificationSound.play().catch(() => {});
  }
  addMessage(msg);
  initMessageHandlers();
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
      const seenStatus = message.querySelector('.message-status');
      if (seenStatus) {
        const seenNames = update.seenBy.map(u => u === username ? 'You' : u).join(', ');
        seenStatus.innerHTML = `
          <span class="seen-icon">${update.seenBy.length > 1 ? '✓✓' : '✓'}</span>
          ${seenNames ? `<span class="seen-users">${seenNames}</span>` : ''}
        `;
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