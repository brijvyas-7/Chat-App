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

// Enhanced scrollToBottom function
function scrollToBottom(force = false) {
  const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 100;
  if (force || nearBottom) {
    // Use instant scroll when keyboard is open or on iOS
    const behavior = document.body.classList.contains('keyboard-open') || /iPad|iPhone|iPod/.test(navigator.userAgent) 
      ? 'auto' 
      : 'smooth';
    
    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior
    });
  }
}

// Play notification sound on first interaction
document.body.addEventListener('click', () => { 
  notificationSound.play().catch(() => {}); 
}, { once: true });

// Handle incoming message
socket.on('message', msg => {
  if (msg.username !== username && msg.username !== 'ChatApp Bot' && !isMuted) {
    notificationSound.play().catch(() => {});
  }
  addMessage(msg);
});

// Show typing indicator at bottom (WhatsApp style)
socket.on('showTyping', ({ username: u }) => {
  if (u !== username && !typingUsers.has(u)) {
    typingUsers.add(u);
    
    // Remove existing typing indicator if any
    const existingIndicator = document.querySelector('.typing-indicator');
    if (existingIndicator) {
      existingIndicator.remove();
    }
    
    // Create new typing indicator at bottom
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message typing typing-indicator';
    typingDiv.innerHTML = `
      <div class="text d-flex gap-1">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="meta"><strong>${u}</strong> is typing...</div>
    `;
    
    chatMessages.appendChild(typingDiv);
    scrollToBottom(true); // Force scroll when typing appears
    
    setTimeout(() => {
      typingUsers.delete(u);
      if (!typingUsers.size) {
        const indicator = document.querySelector('.typing-indicator');
        if (indicator) indicator.remove();
      }
    }, 1500);
  }
});

function addMessage({ id: msgID, username: u, text, time, replyTo: r }) {
  // Remove typing indicator when new message arrives
  const typingIndicator = document.querySelector('.typing-indicator');
  if (typingIndicator) typingIndicator.remove();
  
  const div = document.createElement('div');
  div.className = 'message ' + (u === username ? 'you' : 'other');
  div.id = msgID;

  if (r) {
    const rb = document.createElement('div');
    rb.className = 'reply-box';
    rb.innerHTML = `<strong>${r.username}</strong>: ${r.text}`;
    rb.addEventListener('click', () => {
      const target = document.getElementById(r.id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    div.appendChild(rb);
  }

  div.innerHTML += `
    <div class="meta"><strong>${u}</strong> @ ${time}</div>
    <div class="text">${text}</div>
  `;

  // Swipe or context reply
  let sx = 0;
  div.addEventListener('touchstart', e => sx = e.touches[0].clientX);
  div.addEventListener('touchend', e => {
    if (e.changedTouches[0].clientX - sx > 60) {
      replyTo = { id: msgID, username: u, text };
      replyUserElem.textContent = u;
      replyTextElem.textContent = text;
      replyPreview.classList.remove('d-none');
      msgInput.focus();
      navigator.vibrate?.(100);
    }
  });
  
  div.addEventListener('contextmenu', e => {
    e.preventDefault();
    replyTo = { id: msgID, username: u, text };
    replyUserElem.textContent = u;
    replyTextElem.textContent = text;
    replyPreview.classList.remove('d-none');
    msgInput.focus();
    navigator.vibrate?.(100);
  });

  chatMessages.appendChild(div);
  scrollToBottom(true); // Always scroll to bottom for new messages
}

// Form submit
document.getElementById('chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const txt = msgInput.value.trim();
  if (!txt) return;
  
  socket.emit('chatMessage', { 
    text: txt, 
    replyTo: replyTo ? { ...replyTo } : null 
  });
  
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
});

// Typing event
let typingTimeout;
msgInput.addEventListener('input', () => {
  socket.emit('typing');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    // Automatically stop typing indication after 2 seconds of inactivity
  }, 2000);
});

// iOS Keyboard Handling
if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
  let originalViewportHeight = window.innerHeight;
  
  function handleKeyboard() {
    const currentViewportHeight = window.innerHeight;
    const isKeyboardVisible = currentViewportHeight < originalViewportHeight;
    
    if (isKeyboardVisible) {
      document.body.classList.add('keyboard-open');
      setTimeout(() => {
        scrollToBottom(true);
        chatMessages.style.paddingBottom = 'calc(60px + env(safe-area-inset-bottom))';
      }, 300);
    } else {
      document.body.classList.remove('keyboard-open');
      chatMessages.style.paddingBottom = '60px';
    }
    
    originalViewportHeight = currentViewportHeight;
  }

  // Initial check
  handleKeyboard();
  
  // Add event listeners
  window.addEventListener('resize', handleKeyboard);
  window.addEventListener('orientationchange', handleKeyboard);
}

// Cancel reply
cancelReplyBtn.addEventListener('click', () => {
  replyTo = null;
  replyPreview.classList.add('d-none');
});

// Theme toggle
themeBtn.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  const icon = themeBtn.querySelector('i');
  icon.classList.toggle('fa-moon');
  icon.classList.toggle('fa-sun');
});

// Mute toggle
muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('isMuted', isMuted);
  const icon = muteBtn.querySelector('i');
  icon.classList.toggle('fa-bell');
  icon.classList.toggle('fa-bell-slash');
});

// Handle iOS viewport changes
function handleViewportChanges() {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    const appContainer = document.querySelector('.app-container');
    const updateHeight = () => {
      const vh = window.innerHeight;
      appContainer.style.height = `${vh}px`;
    };
    
    updateHeight();
    window.addEventListener('resize', updateHeight);
  }
}

// Initialize
handleViewportChanges();