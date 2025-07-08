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

const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });
let replyTo = null, isMuted = localStorage.getItem('isMuted') === 'true';
const typingUsers = new Set();

// Join room
socket.emit('joinRoom', { username, room });

// Scroll to bottom function
function scrollToBottom(force = false) {
  try {
    const messages = chatMessages;
    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 200;
    
    if (force || nearBottom) {
      messages.scrollTo({
        top: messages.scrollHeight,
        behavior: 'smooth'
      });
    }
  } catch (e) {
    console.log('Scroll error:', e);
  }
}

// Add message to chat
function addMessage({ id: msgID, username: u, text, time, replyTo: r }) {
  const div = document.createElement('div');
  div.className = `message ${u === username ? 'you' : 'other'}${r ? ' has-reply' : ''}`;
  div.id = msgID;

  if (r) {
    const replyDiv = document.createElement('div');
    replyDiv.className = 'message-reply';
    replyDiv.innerHTML = `
      <div class="reply-indicator">
        <div class="reply-line"></div>
        <div class="reply-content">
          <div class="reply-sender">${r.username}</div>
          <div class="reply-text">${r.text}</div>
        </div>
      </div>
    `;
    div.appendChild(replyDiv);
  }

  div.innerHTML += `
    <div class="meta"><strong>${u}</strong> @ ${time}</div>
    <div class="text">${text}</div>
  `;

  // Add reply functionality
  div.addEventListener('contextmenu', e => {
    e.preventDefault();
    setupReply(u, msgID, text);
  });

  chatMessages.appendChild(div);
  scrollToBottom(true);
}

// Setup reply
function setupReply(username, msgID, text) {
  replyTo = { id: msgID, username, text };
  replyUserElem.textContent = username;
  replyTextElem.textContent = text.length > 30 ? text.substring(0, 30) + '...' : text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();
  if (navigator.vibrate) navigator.vibrate(100);
}

// Form submit
document.getElementById('chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const txt = msgInput.value.trim();
  if (!txt) return;
  
  socket.emit('chatMessage', { 
    text: txt, 
    replyTo: replyTo ? { 
      id: replyTo.id, 
      username: replyTo.username, 
      text: replyTo.text 
    } : null 
  });
  
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
});

// Cancel reply
cancelReplyBtn.addEventListener('click', e => {
  e.stopPropagation();
  replyTo = null;
  replyPreview.classList.add('d-none');
});

// Typing indicator
let typingTimeout;
msgInput.addEventListener('input', () => {
  socket.emit('typing');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    // Stop typing indication
  }, 2000);
});

// Theme toggle
themeBtn.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  const icon = themeBtn.querySelector('i');
  icon.classList.toggle('fa-moon');
  icon.classList.toggle('fa-sun');
  localStorage.setItem('darkMode', document.body.classList.contains('dark'));
});

// Mute toggle
muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('isMuted', isMuted);
  const icon = muteBtn.querySelector('i');
  icon.classList.toggle('fa-bell');
  icon.classList.toggle('fa-bell-slash');
});

// Initialize dark mode if previously set
if (localStorage.getItem('darkMode') === 'true') {
  document.body.classList.add('dark');
  themeBtn.querySelector('i').classList.replace('fa-moon', 'fa-sun');
}

// iOS Keyboard Handling
if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
  let originalHeight = window.innerHeight;
  
  function checkKeyboard() {
    const currentHeight = window.innerHeight;
    const keyboardVisible = currentHeight < originalHeight * 0.7;
    
    if (keyboardVisible) {
      document.body.classList.add('keyboard-open');
      setTimeout(() => {
        scrollToBottom(true);
      }, 300);
    } else {
      document.body.classList.remove('keyboard-open');
    }
    
    // Update original height for next check
    originalHeight = currentHeight;
  }
  
  // Initial check
  checkKeyboard();
  
  // Event listeners
  window.addEventListener('resize', checkKeyboard);
  window.addEventListener('orientationchange', () => {
    setTimeout(checkKeyboard, 300);
  });
  
  // Additional fix for input focus
  msgInput.addEventListener('focus', () => {
    setTimeout(() => {
      scrollToBottom(true);
    }, 500);
  });
}

// Handle incoming messages
socket.on('message', msg => {
  if (msg.username !== username && msg.username !== 'ChatApp Bot' && !isMuted) {
    notificationSound.play().catch(() => {});
  }
  addMessage(msg);
});

// Handle typing indicators
socket.on('showTyping', ({ username: u }) => {
  if (u !== username && !typingUsers.has(u)) {
    typingUsers.add(u);
    
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message typing typing-indicator';
    typingDiv.innerHTML = `
      <div class="text d-flex gap-1">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="meta"><strong>${u}</strong> is typing...</div>
    `;
    
    chatMessages.appendChild(typingDiv);
    scrollToBottom(true);
    
    setTimeout(() => {
      typingUsers.delete(u);
      const indicator = document.querySelector('.typing-indicator');
      if (indicator) indicator.remove();
    }, 1500);
  }
});

// PWA Installation
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  const installBtn = document.getElementById('installPWA');
  installBtn.classList.remove('d-none');
  installBtn.addEventListener('click', () => {
    e.prompt();
    installBtn.classList.add('d-none');
  });
});

// Initial scroll to bottom
setTimeout(() => {
  scrollToBottom(true);
}, 500);
// Swipe-to-reply implementation
let touchStartX = 0;
let currentSwipeMsg = null;

// Add to each message element:
function addSwipeListener(msgElement) {
  msgElement.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    currentSwipeMsg = msgElement;
  });
  
  msgElement.addEventListener('touchmove', (e) => {
    if (!currentSwipeMsg) return;
    const diff = e.touches[0].clientX - touchStartX;
    if (diff > 0 && diff < 100) {
      msgElement.style.transform = `translateX(${diff}px)`;
    }
  });
  
  msgElement.addEventListener('touchend', (e) => {
    if (!currentSwipeMsg) return;
    const diff = e.changedTouches[0].clientX - touchStartX;
    if (diff > 60) {
      const msgId = msgElement.id;
      const username = msgElement.querySelector('.meta strong').textContent;
      const text = msgElement.querySelector('.text').textContent;
      setupReply(username, msgId, text);
    }
    msgElement.style.transform = '';
    currentSwipeMsg = null;
  });
}

// Enhanced keyboard detection
function setupKeyboardHandling() {
  if (!/iPad|iPhone|iPod/.test(navigator.userAgent)) return;

  let visualViewport = window.visualViewport;
  
  visualViewport.addEventListener('resize', () => {
    const keyboardHeight = window.innerHeight - visualViewport.height;
    if (keyboardHeight > 100) {
      document.body.classList.add('keyboard-open');
      scrollToBottom(true);
    } else {
      document.body.classList.remove('keyboard-open');
    }
  });
}

// Initialize in your socket.io connection callback
socket.on('connect', () => {
  setupKeyboardHandling();
  
  // Add to each new message
  socket.on('message', (msg) => {
    // ... existing message handling ...
    const msgElement = document.getElementById(msg.id);
    if (msgElement) addSwipeListener(msgElement);
  });
});