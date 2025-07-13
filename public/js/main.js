// Initialize Socket.IO first
const socket = io();
console.log("Socket initialized:", socket.id);

// Temporarily disable service worker during development
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => registration.unregister());
  });
}

// DOM Elements
const msgInput = document.getElementById('msg');
const chatMessages = document.getElementById('chat-messages');
const replyPreview = document.getElementById('reply-preview');
const replyUserElem = document.getElementById('reply-user');
const replyTextElem = document.getElementById('reply-text');
const cancelReplyBtn = document.getElementById('cancel-reply');
const themeBtn = document.getElementById('theme-toggle');
const muteBtn = document.getElementById('mute-toggle');
const roomNameElem = document.getElementById('room-name');
const videoCallBtn = document.getElementById('video-call-btn');
const videoCallContainer = document.getElementById('video-call-container');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const endCallBtn = document.getElementById('end-call-btn');
const toggleAudioBtn = document.getElementById('toggle-audio-btn');
const toggleVideoBtn = document.getElementById('toggle-video-btn');

// Audio Elements
const notificationSound = new Audio('/sounds/notification.mp3');
const callSound = new Audio('/sounds/call.mp3');

// State Variables
const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });
let replyTo = null;
let isMuted = localStorage.getItem('isMuted') === 'true';
const typingUsers = new Set();
let typingIndicator = null;
let lastTypingUpdate = 0;
let touchStartX = 0;
const SWIPE_THRESHOLD = 60;

// WebRTC Variables
let localStream;
let remoteStream;
let peerConnection;
let isAudioMuted = false;
let isVideoOff = false;
let iceCandidatesQueue = [];
let currentCallId = null;
let callTimeout = null;

// ICE Servers Configuration
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// UUID generator for call IDs
const uuidv4 = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Initialize the app
function init() {
  initDarkMode();
  setupKeyboardHandling();
  scrollToBottom(true);
  initMessageHandlers();
  fixInputBox();
  setupEventListeners();
  updateMediaButtons();

  // Set room name in header
  roomNameElem.textContent = room || 'Global Chat';
}

// Initialize dark mode
function initDarkMode() {
  const isDark = localStorage.getItem('darkMode') === 'true';
  document.body.classList.toggle('dark', isDark);
  updateThemeIcon(isDark);
  updateBackgroundColors(isDark);
}

function updateThemeIcon(isDark) {
  const icon = themeBtn.querySelector('i');
  icon.classList.toggle('fa-moon', !isDark);
  icon.classList.toggle('fa-sun', isDark);
}

function updateBackgroundColors(isDark) {
  const chatContainer = document.querySelector('.chat-container');
  const messagesContainer = document.querySelector('.messages-container');

  if (isDark) {
    chatContainer.style.backgroundColor = 'var(--terminal-bg)';
    messagesContainer.style.backgroundColor = 'var(--terminal-bg)';
  } else {
    chatContainer.style.backgroundColor = '';
    messagesContainer.style.backgroundColor = '';
  }
}

// Scroll to bottom of chat
function scrollToBottom(force = false) {
  const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 200;
  if (force || nearBottom) {
    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior: 'smooth'
    });
  }
  markMessagesAsSeen();
}

// Message handlers
function initMessageHandlers() {
  const messages = document.querySelectorAll('.message:not(.system)');
  messages.forEach(msg => {
    if (!document.body.classList.contains('dark')) {
      setupSwipeHandler(msg);
    }

    msg.addEventListener('click', () => {
      if (window.innerWidth > 768) {
        const msgId = msg.id;
        const username = msg.querySelector('.meta strong')?.textContent;
        const text = msg.querySelector('.text')?.textContent;

        if (username && text) {
          setupReply(username, msgId, text);
        }
      }
    });
  });
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
      const username = messageElement.querySelector('.meta strong')?.textContent;
      const text = messageElement.querySelector('.text')?.textContent;

      if (username && text) {
        setupReply(username, msgId, text);
      }
    }
    messageElement.style.transform = '';
  }, { passive: true });
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

  if (msg.replyTo) {
    messageContent += `
      <div class="message-reply">
        <span class="reply-sender">${msg.replyTo.username}</span>
        <span class="reply-text">${msg.replyTo.text}</span>
      </div>
    `;
  }

  if (isDark) {
    messageContent += `
      <div class="meta">
        <span class="prompt-sign">${msg.username === username ? '>' : '$'}</span>
        <strong>${msg.username}</strong>
        <span class="message-time">${msg.time} :</span>
      </div>
      <div class="text">${msg.text}</div>
    `;
  } else {
    messageContent += `
      <div class="meta">
        <strong>${msg.username}</strong>
        <span class="message-time">${msg.time}</span>
      </div>
      <div class="text">${msg.text}</div>
    `;
  }

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
  replyTextElem.textContent = text.length > 30 ? text.substring(0, 30) + '...' : text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();

  if (navigator.vibrate) navigator.vibrate(50);

  setTimeout(() => {
    document.querySelector('.input-container').scrollIntoView({ behavior: 'smooth' });
  }, 100);
}

// Typing indicators
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

// Update media control buttons
function updateMediaButtons() {
  toggleAudioBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i> ${isAudioMuted ? 'Unmute' : 'Mute'}`;
  toggleVideoBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i> ${isVideoOff ? 'Video On' : 'Video Off'}`;
  muteBtn.innerHTML = `<i class="fas fa-bell${isMuted ? '-slash' : ''}"></i>`;
}

// Setup event listeners
function setupEventListeners() {
  // Chat form submission
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

  // Cancel reply
  cancelReplyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    replyTo = null;
    replyPreview.classList.add('d-none');
  });

  // Theme toggle
  themeBtn.addEventListener('click', () => {
    const isDark = !document.body.classList.contains('dark');
    document.body.classList.toggle('dark', isDark);
    localStorage.setItem('darkMode', isDark);
    updateThemeIcon(isDark);
    updateBackgroundColors(isDark);
    fixInputBox();
    initMessageHandlers();
  });

  // Mute toggle
  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    localStorage.setItem('isMuted', isMuted);
    updateMediaButtons();
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

  // Video call button
  videoCallBtn.addEventListener('click', async () => {
    console.log("Video call button clicked");
    await startVideoCall();
  });

  // Visibility change handler
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      markMessagesAsSeen();
    }
  });

  // Page unload handler
  window.addEventListener('beforeunload', () => {
    if (peerConnection) {
      socket.emit('end-call', { room, callId: currentCallId });
      endVideoCall();
    }
  });

  // iOS-specific fixes
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    window.addEventListener('resize', () => {
      document.querySelector('header').style.position = 'sticky';
    });
  }
}

/* ====================== */
/* VIDEO CALL FUNCTIONALITY */
/* ====================== */

// Initialize video call
async function startVideoCall() {
  try {
    if (!await checkMediaPermissions()) return;
    
    currentCallId = uuidv4();
    console.log("Starting video call with ID:", currentCallId);

    // Create peer connection
    peerConnection = new RTCPeerConnection(configuration);

    // Get local media stream
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    localVideo.srcObject = localStream;

    // Add tracks to connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Set up remote stream handler
    peerConnection.ontrack = event => {
      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
      showVideoCallUI();
    };

    // ICE candidate handler
    peerConnection.onicecandidate = event => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          candidate: event.candidate,
          room,
          callId: currentCallId
        });
      }
    };

    // Connection state handler
    peerConnection.onconnectionstatechange = () => {
      console.log('Connection state:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'disconnected') {
        endVideoCall();
      }
    };

    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // Show calling UI
    showCallingUI();

    // Send offer to other users in room
    socket.emit('video-call-initiate', {
      offer,
      room,
      callId: currentCallId,
      caller: username
    });

    // Set timeout for unanswered call
    callTimeout = setTimeout(() => {
      if (!remoteStream) {
        endVideoCall();
        alert('Call was not answered');
      }
    }, 30000); // 30 second timeout

  } catch (error) {
    console.error('Error starting call:', error);
    endVideoCall();
    alert('Failed to start call: ' + error.message);
  }
}

// Handle incoming call
async function handleIncomingCall({ offer, callId, caller }) {
  if (peerConnection) {
    socket.emit('reject-call', { room, callId, reason: 'busy' });
    return;
  }

  const acceptCall = confirm(`${caller} is calling. Accept?`);
  
  if (!acceptCall) {
    socket.emit('reject-call', { room, callId });
    return;
  }

  try {
    currentCallId = callId;

    // Get local media
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    localVideo.srcObject = localStream;

    // Create peer connection
    peerConnection = new RTCPeerConnection(configuration);

    // Add local tracks
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Set up remote stream handler
    peerConnection.ontrack = event => {
      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
      showVideoCallUI();
    };

    // ICE candidate handler
    peerConnection.onicecandidate = event => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          candidate: event.candidate,
          room,
          callId: currentCallId
        });
      }
    };

    // Connection state handler
    peerConnection.onconnectionstatechange = () => {
      console.log('Connection state:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'disconnected') {
        endVideoCall();
      }
    };

    // Set remote description
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    // Create answer
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    // Send answer to caller
    socket.emit('video-answer', {
      answer,
      room,
      callId: currentCallId
    });

    // Process any queued ICE candidates
    processQueuedCandidates();

  } catch (error) {
    console.error('Error handling incoming call:', error);
    socket.emit('reject-call', { room, callId });
    endVideoCall();
    alert('Failed to accept call: ' + error.message);
  }
}

// Process queued ICE candidates
function processQueuedCandidates() {
  if (!peerConnection) return;

  iceCandidatesQueue.forEach(candidate => {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(e => console.error("Error adding queued ICE candidate:", e));
  });

  iceCandidatesQueue = [];
}

// Show calling UI (waiting for answer)
function showCallingUI() {
  videoCallContainer.classList.remove('d-none');
  videoCallContainer.innerHTML = `
    <div class="calling-ui">
      <div class="calling-spinner"></div>
      <div class="calling-text">Calling...</div>
      <button id="cancel-call-btn" class="btn btn-danger">
        <i class="fas fa-phone-slash"></i> Cancel
      </button>
    </div>
  `;

  document.getElementById('cancel-call-btn').addEventListener('click', endVideoCall);
  callSound.loop = true;
  callSound.play().catch(e => console.log("Call sound error:", e));
}

// Show active call UI
function showVideoCallUI() {
  clearTimeout(callTimeout);
  callSound.pause();
  callSound.currentTime = 0;

  videoCallContainer.innerHTML = `
    <div class="video-grid">
      <video id="remote-video" autoplay playsinline></video>
      <video id="local-video" autoplay playsinline muted></video>
    </div>
    <div class="video-controls">
      <button id="toggle-audio-btn" class="btn btn-light">
        <i class="fas fa-microphone"></i> Mute
      </button>
      <button id="toggle-video-btn" class="btn btn-light">
        <i class="fas fa-video"></i> Video Off
      </button>
      <button id="end-call-btn" class="btn btn-danger">
        <i class="fas fa-phone-slash"></i> End Call
      </button>
    </div>
  `;

  // Update references to new elements
  const newLocalVideo = document.getElementById('local-video');
  const newRemoteVideo = document.getElementById('remote-video');
  const newToggleAudioBtn = document.getElementById('toggle-audio-btn');
  const newToggleVideoBtn = document.getElementById('toggle-video-btn');
  const newEndCallBtn = document.getElementById('end-call-btn');

  newLocalVideo.srcObject = localStream;
  if (remoteStream) newRemoteVideo.srcObject = remoteStream;

  newToggleAudioBtn.addEventListener('click', toggleAudio);
  newToggleVideoBtn.addEventListener('click', toggleVideo);
  newEndCallBtn.addEventListener('click', endVideoCall);

  updateMediaButtons();
}

// End video call
function endVideoCall() {
  console.log("Ending video call");
  
  // Stop all media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
  }
  
  // Close peer connection
  if (peerConnection) {
    peerConnection.close();
  }

  // Clear video elements
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  
  // Hide UI
  hideCallingUI();
  
  // Notify server
  if (currentCallId) {
    socket.emit('end-call', { room, callId: currentCallId });
  }

  // Reset state
  localStream = null;
  remoteStream = null;
  peerConnection = null;
  currentCallId = null;
  clearTimeout(callTimeout);
  callSound.pause();
  callSound.currentTime = 0;
}

// Hide calling UI
function hideCallingUI() {
  videoCallContainer.classList.add('d-none');
  callSound.pause();
  callSound.currentTime = 0;
  clearTimeout(callTimeout);
}

// Toggle audio mute
function toggleAudio() {
  if (localStream) {
    const audioTracks = localStream.getAudioTracks();
    audioTracks.forEach(track => {
      track.enabled = !track.enabled;
    });
    isAudioMuted = !isAudioMuted;
    updateMediaButtons();
  }
}

// Toggle video
function toggleVideo() {
  if (localStream) {
    const videoTracks = localStream.getVideoTracks();
    videoTracks.forEach(track => {
      track.enabled = !track.enabled;
    });
    isVideoOff = !isVideoOff;
    updateMediaButtons();
  }
}

// Check media permissions
async function checkMediaPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch (error) {
    console.error("Permission denied:", error);
    alert("Please allow camera/microphone access to make video calls!");
    return false;
  }
}

/* ====================== */
/* SOCKET.IO EVENT HANDLERS */
/* ====================== */

socket.on('connect', () => {
  console.log('Connected to server');
  socket.emit('joinRoom', { username, room });
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  if (peerConnection) {
    endVideoCall();
  }
});

// Message handling
socket.on('message', (msg) => {
  if (msg.username !== username && msg.username !== 'ChatApp Bot' && !isMuted) {
    notificationSound.play().catch(() => { });
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

// Typing indicators
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

// Seen status updates
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

// Video call handlers
socket.on('incoming-call', handleIncomingCall);

socket.on('video-answer', async ({ answer, callId }) => {
  if (!peerConnection || currentCallId !== callId) return;

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    processQueuedCandidates();
  } catch (error) {
    console.error('Error setting remote description:', error);
    endVideoCall();
  }
});

socket.on('ice-candidate', async ({ candidate, callId }) => {
  if (!peerConnection) {
    iceCandidatesQueue.push(candidate);
    return;
  }

  if (currentCallId !== callId) return;

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error('Error adding ICE candidate:', error);
  }
});

socket.on('end-call', ({ callId }) => {
  if (currentCallId === callId || !currentCallId) {
    endVideoCall();
    alert('The other party has ended the call.');
  }
});

socket.on('reject-call', ({ callId, reason }) => {
  if (currentCallId === callId) {
    endVideoCall();
    alert(reason === 'busy' ? 'The user is busy.' : 'Call rejected.');
  }
});

// Initialize the app
init();