// Initialize Socket.IO
const socket = io({
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});
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

// Audio Elements
const notificationSound = new Audio('/sounds/notification.mp3');
const callSound = new Audio('/sounds/call.mp3');

// State Variables
const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true }) || {};
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
let isCallActive = false;
let isCaller = false;

// Enhanced ICE Servers Configuration
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { 
      urls: 'turn:global.turn.twilio.com:3478?transport=udp',
      username: 'YOUR_TWILIO_USERNAME', // Replace with your Twilio credentials
      credential: 'YOUR_TWILIO_CREDENTIAL'
    }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceTransportPolicy: 'all'
};

// UUID generator for call IDs
const uuidv4 = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

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
  let isKeyboardOpen = false;

  // iOS specific fixes
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    window.addEventListener('resize', () => {
      const newHeight = window.innerHeight;
      const keyboardThreshold = 300;
      
      if (Math.abs(newHeight - lastHeight) > keyboardThreshold) {
        isKeyboardOpen = newHeight < lastHeight;
        
        if (isKeyboardOpen) {
          // Keyboard opened
          document.querySelector('header').style.position = 'static';
          setTimeout(() => {
            scrollToBottom(true);
          }, 300);
        } else {
          // Keyboard closed
          document.querySelector('header').style.position = 'sticky';
        }
      }
      
      lastHeight = newHeight;
    });
  }

  // Android and general handling
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
  const audioBtn = document.getElementById('toggle-audio-btn');
  const videoBtn = document.getElementById('toggle-video-btn');
  
  if (audioBtn) {
    audioBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
    audioBtn.style.background = isAudioMuted ? '#ff9800' : '#4CAF50';
  }
  
  if (videoBtn) {
    videoBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
    videoBtn.style.background = isVideoOff ? '#ff9800' : '#2196F3';
  }
  
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
        <i class="fas fa-phone-slash"></i>
      </button>
    </div>
  `;

  document.getElementById('cancel-call-btn').addEventListener('click', endVideoCall);
  
  if (isCaller) {
    callSound.loop = true;
    callSound.play().catch(e => console.log("Call sound error:", e));
  }
}

// Show active call UI
function showVideoCallUI() {
  clearTimeout(callTimeout);
  callSound.pause();
  callSound.currentTime = 0;

  videoCallContainer.innerHTML = `
    <div class="video-grid">
      <video id="remote-video" autoplay playsinline class="remote-video"></video>
      <video id="local-video" autoplay playsinline muted class="local-video"></video>
    </div>
    <div class="video-controls">
      <button id="toggle-audio-btn" class="control-btn audio-btn">
        <i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>
      </button>
      <button id="end-call-btn" class="control-btn end-btn">
        <i class="fas fa-phone-slash"></i>
      </button>
      <button id="toggle-video-btn" class="control-btn video-btn">
        <i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>
      </button>
    </div>
  `;

  // Update references to new elements
  const newLocalVideo = document.getElementById('local-video');
  const newRemoteVideo = document.getElementById('remote-video');
  const newToggleAudioBtn = document.getElementById('toggle-audio-btn');
  const newToggleVideoBtn = document.getElementById('toggle-video-btn');
  const newEndCallBtn = document.getElementById('end-call-btn');

  if (localStream) newLocalVideo.srcObject = localStream;
  if (remoteStream) newRemoteVideo.srcObject = remoteStream;

  newToggleAudioBtn.addEventListener('click', toggleAudio);
  newToggleVideoBtn.addEventListener('click', toggleVideo);
  newEndCallBtn.addEventListener('click', endVideoCall);

  updateMediaButtons();

  // Add CSS for proper video layout
  const style = document.createElement('style');
  style.textContent = `
    .video-call-container {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: #000;
      z-index: 1000;
      display: flex;
      flex-direction: column;
    }
    
    .video-grid {
      flex: 1;
      position: relative;
      overflow: hidden;
    }
    
    .remote-video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    
    .local-video {
      position: absolute;
      bottom: 20px;
      right: 20px;
      width: 25%;
      max-width: 200px;
      border: 2px solid #fff;
      border-radius: 8px;
      z-index: 1001;
    }
    
    .video-controls {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 30px;
      padding: 20px;
      background: rgba(0,0,0,0.5);
    }
    
    .control-btn {
      width: 50px;
      height: 50px;
      border-radius: 50%;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 20px;
      transition: all 0.2s;
      color: white;
    }
    
    .audio-btn {
      background: ${isAudioMuted ? '#ff9800' : '#4CAF50'};
    }
    
    .video-btn {
      background: ${isVideoOff ? '#ff9800' : '#2196F3'};
    }
    
    .end-btn {
      background: #f44336;
      width: 60px;
      height: 60px;
    }
    
    .control-btn:hover {
      transform: scale(1.1);
    }
    
    .control-btn i {
      pointer-events: none;
    }
    
    .calling-ui {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: white;
    }
    
    .calling-spinner {
      width: 60px;
      height: 60px;
      border: 5px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 1s ease-in-out infinite;
      margin-bottom: 20px;
    }
    
    .calling-text {
      font-size: 24px;
      margin-bottom: 30px;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
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
  isCallActive = false;
  isCaller = false;
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

    const audioBtn = document.getElementById('toggle-audio-btn');
    if (audioBtn) {
      audioBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
      audioBtn.style.background = isAudioMuted ? '#ff9800' : '#4CAF50';
    }
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

    const videoBtn = document.getElementById('toggle-video-btn');
    if (videoBtn) {
      videoBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
      videoBtn.style.background = isVideoOff ? '#ff9800' : '#2196F3';
    }

    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      localVideo.style.borderColor = isVideoOff ? '#f44336' : '#fff';
    }
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

// Initialize video call
async function startVideoCall() {
  try {
    if (isCallActive) {
      console.log("Call already active");
      return;
    }

    if (!await checkMediaPermissions()) return;

    currentCallId = uuidv4();
    console.log("Starting video call with ID:", currentCallId);
    isCallActive = true;
    isCaller = true;

    // Create peer connection
    peerConnection = new RTCPeerConnection(configuration);

    // Get local media stream with enhanced audio settings
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
      },
      audio: {
        echoCancellation: { exact: true },
        noiseSuppression: { exact: true },
        autoGainControl: { exact: true },
        sampleRate: 48000,
        channelCount: 1,
        latency: 0.01,
        volume: 1.0
      }
    });

    // Display local video immediately
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Mute local video to avoid echo
    localVideo.play().catch(e => console.log("Local video play error:", e));

    // Add tracks to connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Set up remote stream handler
    peerConnection.ontrack = event => {
      if (!event.streams || event.streams.length === 0) return;

      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
      remoteVideo.play().catch(e => console.log("Remote video play error:", e));

      // Show both videos when remote stream is received
      showVideoCallUI();
    };

    // ICE candidate handler
    peerConnection.onicecandidate = event => {
      if (event.candidate && currentCallId) {
        socket.emit('ice-candidate', {
          candidate: event.candidate,
          room,
          callId: currentCallId
        });
      }
    };

    // Connection state handling
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log('Connection state:', state);

      if (state === 'connected') {
        clearTimeout(callTimeout);
      } else if (state === 'disconnected' || state === 'failed') {
        endVideoCall();
        showCallEndedUI('Call disconnected');
      }
    };

    // ICE gathering state change
    peerConnection.onicegatheringstatechange = () => {
      console.log('ICE gathering state:', peerConnection.iceGatheringState);
    };

    // ICE connection state change
    peerConnection.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', peerConnection.iceConnectionState);
      if (peerConnection.iceConnectionState === 'disconnected' || 
          peerConnection.iceConnectionState === 'failed') {
        endVideoCall();
        showCallEndedUI('Call disconnected');
      }
    };

    // Create offer
    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
      voiceActivityDetection: false // Reduces noise
    });
    
    // Set codec preferences for better audio quality
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
        showCallEndedUI('Call was not answered');
      }
    }, 30000);

  } catch (error) {
    console.error('Error starting call:', error);
    endVideoCall();
    showCallEndedUI('Failed to start call: ' + error.message);
  }
}

// Handle incoming call
async function handleIncomingCall({ offer, callId, caller }) {
  if (peerConnection || isCallActive) {
    socket.emit('reject-call', { room, callId, reason: 'busy' });
    return;
  }

  // Play call sound only for receiver
  callSound.loop = true;
  callSound.play().catch(e => console.log("Call sound error:", e));

  const acceptCall = confirm(`${caller} is calling. Accept?`);
  
  if (!acceptCall) {
    callSound.pause();
    callSound.currentTime = 0;
    socket.emit('reject-call', { room, callId });
    return;
  }

  try {
    callSound.pause();
    callSound.currentTime = 0;
    
    currentCallId = callId;
    isCallActive = true;
    isCaller = false;

    // Get local media with enhanced audio settings
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
      },
      audio: {
        echoCancellation: { exact: true },
        noiseSuppression: { exact: true },
        autoGainControl: { exact: true },
        sampleRate: 48000,
        channelCount: 1,
        latency: 0.01,
        volume: 1.0
      }
    });
    
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    localVideo.play().catch(e => console.log("Local video play error:", e));

    // Create peer connection
    peerConnection = new RTCPeerConnection(configuration);

    // Add local tracks
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Set up remote stream handler
    peerConnection.ontrack = event => {
      if (!event.streams || event.streams.length === 0) return;

      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
      remoteVideo.play().catch(e => console.log("Remote video play error:", e));
      showVideoCallUI();
    };

    // ICE candidate handler
    peerConnection.onicecandidate = event => {
      if (event.candidate && currentCallId) {
        socket.emit('ice-candidate', {
          candidate: event.candidate,
          room,
          callId: currentCallId
        });
      }
    };

    // Connection state handler
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log('Connection state:', state);

      if (state === 'connected') {
        clearTimeout(callTimeout);
      } else if (state === 'disconnected' || state === 'failed') {
        endVideoCall();
        showCallEndedUI('Call disconnected');
      }
    };

    // ICE gathering state change
    peerConnection.onicegatheringstatechange = () => {
      console.log('ICE gathering state:', peerConnection.iceGatheringState);
    };

    // ICE connection state change
    peerConnection.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', peerConnection.iceConnectionState);
      if (peerConnection.iceConnectionState === 'disconnected' || 
          peerConnection.iceConnectionState === 'failed') {
        endVideoCall();
        showCallEndedUI('Call disconnected');
      }
    };

    // Set remote description
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    // Create answer
    const answer = await peerConnection.createAnswer({
      voiceActivityDetection: false // Reduces noise
    });
    await peerConnection.setLocalDescription(answer);

    // Send answer to caller
    socket.emit('video-answer', {
      answer,
      room,
      callId: currentCallId
    });

    // Process any queued ICE candidates
    processQueuedCandidates();

    // Show video UI immediately
    showVideoCallUI();

  } catch (error) {
    console.error('Error handling incoming call:', error);
    socket.emit('reject-call', { room, callId });
    endVideoCall();
    showCallEndedUI('Failed to accept call: ' + error.message);
  }
}

// Show call ended message
function showCallEndedUI(message) {
  const alertBox = document.createElement('div');
  alertBox.className = 'call-ended-alert';
  alertBox.innerHTML = `
    <div class="alert-content">
      <p>${message}</p>
      <button id="close-alert-btn" class="btn btn-primary">OK</button>
    </div>
  `;

  document.body.appendChild(alertBox);

  document.getElementById('close-alert-btn').addEventListener('click', () => {
    alertBox.remove();
  });

  // Add styles for alert
  const style = document.createElement('style');
  style.textContent = `
    .call-ended-alert {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 2000;
    }
    
    .alert-content {
      background: white;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
      max-width: 80%;
    }
    
    .alert-content p {
      margin-bottom: 20px;
      font-size: 18px;
    }
  `;
  document.head.appendChild(style);
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
    showCallEndedUI('Connection failed');
    
    // Notify the other peer
    socket.emit('call-error', {
      callId,
      room,
      error: 'Failed to set remote description'
    });
  }
});

socket.on('ice-candidate', ({ candidate, callId }) => {
  if (!peerConnection || currentCallId !== callId) {
    // Queue candidates if we're not ready yet
    iceCandidatesQueue.push(candidate);
    return;
  }

  try {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(e => console.error("Error adding ICE candidate:", e));
  } catch (error) {
    console.error('Error processing ICE candidate:', error);
  }
});

socket.on('reject-call', ({ callId, reason }) => {
  if (currentCallId === callId) {
    endVideoCall();
    showCallEndedUI(reason === 'busy' ? 'User is busy' : 'Call rejected');
  }
});

socket.on('end-call', ({ callId }) => {
  if (currentCallId === callId) {
    endVideoCall();
    showCallEndedUI('Call ended by other user');
  }
});

socket.on('call-error', ({ callId, error }) => {
  if (currentCallId === callId) {
    endVideoCall();
    showCallEndedUI(`Call failed: ${error}`);
  }
});
// Initialize the app
function init() {
  if (!username || !room) {
    alert('Missing username or room parameters');
    return;
  }

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

// Start the application
init();