// ✅ Enhanced WebRTC Implementation - Audio Calls & Multi-User Support
const socket = io({ reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });

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
const audioCallBtn = document.getElementById('audio-call-btn');
const videoCallContainer = document.getElementById('video-call-container');

// Audio Elements
const notificationSound = new Audio('/sounds/notification.mp3');
const callSound = new Audio('/sounds/call.mp3');

// Query Params
const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });

// State Variables
let replyTo = null;
let isMuted = localStorage.getItem('isMuted') === 'true';
let lastTypingUpdate = 0;
const SWIPE_THRESHOLD = 60;

// WebRTC Variables
let peerConnections = {}; // Track multiple peer connections
let localStream = null;
let remoteStreams = {}; // Track streams by user ID
let currentCallId = null;
let callTimeout = null;
let isCallActive = false;
let iceQueues = {}; // Track ICE candidates by call ID
let isAudioMuted = false;
let isVideoOff = false;
let currentCallType = null; // 'audio' or 'video'
let currentFacingMode = 'user'; // 'user' or 'environment'

// ICE Configuration
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};

// Helper Functions
const uuidv4 = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
};

// ======================
// UI Functions
// ======================

// Dark Mode
function initDarkMode() {
  const isDark = localStorage.getItem('darkMode') === 'true';
  document.body.classList.toggle('dark', isDark);
  chatMessages.classList.toggle('dark-bg', isDark);
}

themeBtn.onclick = () => {
  const isDark = !document.body.classList.toggle('dark');
  localStorage.setItem('darkMode', isDark);
  chatMessages.classList.toggle('dark-bg', isDark);
};

// Mute Toggle
muteBtn.onclick = () => {
  isMuted = !isMuted;
  localStorage.setItem('isMuted', isMuted);
  muteBtn.innerHTML = isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';
};

muteBtn.innerHTML = isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';

// ======================
// Chat Functions
// ======================

// Reply UI
cancelReplyBtn.onclick = e => {
  e.stopPropagation();
  replyTo = null;
  replyPreview.classList.add('d-none');
};

function setupReply(user, msgID, text) {
  replyTo = { id: msgID, username: user, text };
  replyUserElem.textContent = user;
  replyTextElem.textContent = text.length > 30 ? text.substr(0, 30) + '...' : text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();
}

function addMessage(msg) {
  document.querySelectorAll('.typing-indicator').forEach(el => el.remove());

  const el = document.createElement('div');
  const isMe = msg.username === username;
  const isSystem = msg.username === 'ChatApp Bot';
  el.id = msg.id;
  el.className = `message ${isMe ? 'you' : 'other'}${isSystem ? ' system' : ''}`;

  let html = '';
  if (msg.replyTo) {
    html += `<div class="message-reply"><span class="reply-sender">${msg.replyTo.username}</span><span class="reply-text">${msg.replyTo.text}</span></div>`;
  }
  html += `<div class="meta">${isMe ? '<span class="prompt-sign">></span>' : ''}<strong>${msg.username}</strong><span class="message-time">${msg.time}</span></div><div class="text">${msg.text}</div>`;
  if (isMe) {
    const seen = msg.seenBy || [];
    const seenIcon = seen.length > 1 ? '✓✓' : '✓';
    const seenNames = seen.map(u => u === username ? 'You' : u).join(', ');
    html += `<div class="message-status"><span class="seen-icon">${seenIcon}</span>${seenNames ? `<span class="seen-users">${seenNames}</span>` : ''}</div>`;
  }

  el.innerHTML = html;
  if (!isSystem) {
    el.onclick = () => {
      const user = el.querySelector('.meta strong')?.textContent;
      const text = el.querySelector('.text')?.textContent;
      if (user && text) setupReply(user, el.id, text);
    };
  }

  chatMessages.appendChild(el);
  setTimeout(() => chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' }), 20);
}

// Typing Indicators
msgInput.oninput = () => {
  const now = Date.now();
  if (now - lastTypingUpdate > 1000) {
    socket.emit('typing', { room });
    lastTypingUpdate = now;
  }
  clearTimeout(window._stopTyping);
  window._stopTyping = setTimeout(() => socket.emit('stopTyping', { room }), 2000);
};

function showTypingIndicator(user) {
  if (!document.querySelector('.typing-indicator')) {
    const d = document.createElement('div');
    d.className = 'typing-indicator other';
    d.innerHTML = `<div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><span class="typing-text">${user} is typing...</span>`;
    chatMessages.appendChild(d);
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
  }
}

// ======================
// Swipe to Reply Functionality
// ======================

function setupSwipeToReply() {
  let touchStartX = 0;
  let touchEndX = 0;
  
  chatMessages.addEventListener('touchstart', (e) => {
    if (e.target.closest('.message')) {
      touchStartX = e.changedTouches[0].screenX;
    }
  }, { passive: true });

  chatMessages.addEventListener('touchend', (e) => {
    if (!e.target.closest('.message')) return;
    
    touchEndX = e.changedTouches[0].screenX;
    const messageElement = e.target.closest('.message');
    
    if (Math.abs(touchEndX - touchStartX) > SWIPE_THRESHOLD) {
      if (touchEndX < touchStartX) { // Swipe left
        const user = messageElement.querySelector('.meta strong')?.textContent;
        const text = messageElement.querySelector('.text')?.textContent;
        const msgID = messageElement.id;
        
        if (user && text) {
          setupReply(user, msgID, text);
          
          // Visual feedback
          messageElement.style.transform = 'translateX(-10px)';
          setTimeout(() => {
            messageElement.style.transform = '';
          }, 300);
        }
      }
    }
  }, { passive: true });

  // Mouse support for desktop
  let mouseDownX = 0;
  chatMessages.addEventListener('mousedown', (e) => {
    if (e.target.closest('.message')) {
      mouseDownX = e.screenX;
    }
  });

  chatMessages.addEventListener('mouseup', (e) => {
    if (!e.target.closest('.message')) return;
    
    const mouseUpX = e.screenX;
    const messageElement = e.target.closest('.message');
    
    if (Math.abs(mouseUpX - mouseDownX) > SWIPE_THRESHOLD) {
      if (mouseUpX < mouseDownX) { // Swipe left
        const user = messageElement.querySelector('.meta strong')?.textContent;
        const text = messageElement.querySelector('.text')?.textContent;
        const msgID = messageElement.id;
        
        if (user && text) {
          setupReply(user, msgID, text);
          
          // Visual feedback
          messageElement.classList.add('swipe-feedback');
          setTimeout(() => {
            messageElement.classList.remove('swipe-feedback');
          }, 300);
        }
      }
    }
  });
}

// Add CSS for swipe feedback
const swipeFeedbackCSS = `
  .message.swipe-feedback {
    transform: translateX(-10px);
    transition: transform 0.3s ease;
  }
`;
const style = document.createElement('style');
style.innerHTML = swipeFeedbackCSS;
document.head.appendChild(style);

// ======================
// Call Functions (Audio & Video)
// ======================

// Video UI Functions
function showCallingUI(callType) {
  videoCallContainer.innerHTML = `
    <div class="calling-ui">
      <div class="calling-spinner"></div>
      <div class="calling-text">Calling ${callType === 'audio' ? '(Audio)' : '(Video)'}...</div>
      <button id="cancel-call-btn" class="btn btn-danger"><i class="fas fa-phone-slash"></i> Cancel</button>
    </div>
  `;
  videoCallContainer.classList.remove('d-none');
  document.getElementById('cancel-call-btn').onclick = endCall;
  callSound.loop = true; 
  callSound.play().catch(() => {});
}

function showCallUI(callType) {
  callSound.pause();
  clearTimeout(callTimeout);

  videoCallContainer.innerHTML = `
    <div class="video-call-active">
      <div id="video-grid" class="video-grid">
        <!-- Videos will be added dynamically -->
      </div>
      <div class="video-controls">
        <button id="toggle-audio-btn" class="control-btn audio-btn">
          <i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>
        </button>
        <button id="end-call-btn" class="control-btn end-btn">
          <i class="fas fa-phone-slash"></i>
        </button>
        ${callType === 'video' ? `
        <button id="toggle-video-btn" class="control-btn video-btn">
          <i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>
        </button>
        <button id="flip-camera-btn" class="control-btn flip-btn">
          <i class="fas fa-camera-retro"></i>
        </button>
        ` : ''}
      </div>
    </div>
  `;

  videoCallContainer.classList.remove('d-none');

  // Setup control handlers
  document.getElementById('toggle-audio-btn').onclick = toggleAudio;
  document.getElementById('end-call-btn').onclick = endCall;
  if (callType === 'video') {
    document.getElementById('toggle-video-btn').onclick = toggleVideo;
    document.getElementById('flip-camera-btn').onclick = flipCamera;
  }

  // Add local video if this is a video call
  if (callType === 'video' && localStream) {
    addVideoElement('local', username, localStream, true);
  }
}

function hideCallUI() {
  videoCallContainer.classList.add('d-none');
  callSound.pause();
  clearTimeout(callTimeout);
}

function showCallEndedUI(msg) {
  const div = document.createElement('div');
  div.className = 'call-ended-alert';
  div.innerHTML = `
    <div class="alert-content">
      <p>${msg}</p>
      <button id="close-alert-btn" class="btn btn-primary">OK</button>
    </div>
  `;
  document.body.appendChild(div);
  document.getElementById('close-alert-btn').onclick = () => div.remove();
}

// Video Element Management
function addVideoElement(type, userId, stream, isLocal = false) {
  const videoGrid = document.getElementById('video-grid');
  if (!videoGrid) return;

  // Remove existing video if it exists
  const existingVideo = document.getElementById(`${type}-video-${userId}`);
  if (existingVideo) existingVideo.remove();

  const videoContainer = document.createElement('div');
  videoContainer.className = `video-container ${isLocal ? 'local-video-container' : ''}`;
  videoContainer.id = `${type}-container-${userId}`;

  const videoElem = document.createElement('video');
  videoElem.id = `${type}-video-${userId}`;
  videoElem.autoplay = true;
  videoElem.playsInline = true;
  videoElem.muted = isLocal;
  
  // Fix mirror effect for local video
  if (isLocal && currentCallType === 'video') {
    videoElem.style.transform = 'scaleX(-1)';
  }

  const userLabel = document.createElement('div');
  userLabel.className = 'video-user-label';
  userLabel.textContent = userId === username ? 'You' : userId;

  videoContainer.appendChild(videoElem);
  videoContainer.appendChild(userLabel);
  videoGrid.appendChild(videoContainer);

  videoElem.srcObject = stream;
  videoElem.onloadedmetadata = () => {
    videoElem.play().catch(e => console.error('Video play error:', e));
  };

  return videoElem;
}

// Media Control Functions
function updateMediaButtons() {
  const aBtn = document.getElementById('toggle-audio-btn');
  const vBtn = document.getElementById('toggle-video-btn');
  if (aBtn) aBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
  if (vBtn) vBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
}

async function toggleAudio() {
  isAudioMuted = !isAudioMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = !isAudioMuted);
  }
  updateMediaButtons();
  
  // Notify other peers about mute state
  if (isCallActive && currentCallId) {
    socket.emit('mute-state', { 
      room, 
      callId: currentCallId,
      isAudioMuted,
      userId: username
    });
  }
}

async function toggleVideo() {
  isVideoOff = !isVideoOff;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
  }
  updateMediaButtons();
  
  // Notify other peers about video state
  if (isCallActive && currentCallId) {
    socket.emit('video-state', { 
      room, 
      callId: currentCallId,
      isVideoOff,
      userId: username
    });
  }
}

async function flipCamera() {
  if (!localStream || currentCallType !== 'video') return;
  
  try {
    // Stop current video tracks
    localStream.getVideoTracks().forEach(track => track.stop());
    
    // Switch facing mode
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    
    // Get new stream with opposite facing mode
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: currentFacingMode
      }
    });
    
    // Replace the local stream
    localStream.getVideoTracks().forEach(track => localStream.removeTrack(track));
    newStream.getVideoTracks().forEach(track => localStream.addTrack(track));
    
    // Update all peer connections
    Object.keys(peerConnections).forEach(userId => {
      const sender = peerConnections[userId].getSenders().find(s => s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(localStream.getVideoTracks()[0]);
      }
    });
    
    // Update local video element
    const localVideo = document.getElementById(`local-video-${username}`);
    if (localVideo) {
      localVideo.srcObject = localStream;
    }
  } catch (err) {
    console.error('Error flipping camera:', err);
  }
}

// Call Management
async function startCall(callType) {
  if (isCallActive) return;
  
  try {
    // Test permissions first
    const mediaConstraints = {
      audio: true,
      video: callType === 'video' ? { facingMode: 'user' } : false
    };
    const test = await navigator.mediaDevices.getUserMedia(mediaConstraints);
    test.getTracks().forEach(t => t.stop());
  } catch {
    return alert(`Please allow ${callType === 'video' ? 'camera and microphone' : 'microphone'} access to start a call.`);
  }

  isCallActive = true;
  currentCallType = callType;
  currentCallId = uuidv4();
  iceQueues[currentCallId] = {};

  showCallingUI(callType);

  try {
    // Get local media
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video' ? { facingMode: 'user' } : false
    });

    // Show call UI with local stream
    showCallUI(callType);

    // Notify room about the call
    socket.emit('call-initiate', { 
      room, 
      callId: currentCallId,
      callType,
      caller: username 
    });

    // Set timeout for no answer
    callTimeout = setTimeout(() => {
      if (Object.keys(peerConnections).length === 0) {
        endCall();
        showCallEndedUI('No one answered');
      }
    }, 30000);

  } catch (err) {
    console.error('Call setup error:', err);
    endCall();
    showCallEndedUI('Call failed to start');
  }
}

async function handleIncomingCall({ callType, callId, caller }) {
  if (isCallActive) {
    socket.emit('reject-call', { room, callId, reason: 'busy' });
    return;
  }

  const accept = confirm(`${caller} is ${callType === 'audio' ? 'audio' : 'video'} calling. Accept?`);
  if (!accept) {
    socket.emit('reject-call', { room, callId });
    return;
  }

  isCallActive = true;
  currentCallType = callType;
  currentCallId = callId;
  iceQueues[callId] = {};

  try {
    // Get local media
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video' ? { facingMode: 'user' } : false
    });

    // Show call UI with local stream
    showCallUI(callType);

    // Notify caller that we've accepted
    socket.emit('accept-call', { room, callId });

    // Answer the call by creating peer connections with all existing participants
    socket.emit('get-call-participants', { room, callId });

  } catch (err) {
    console.error('Call setup error:', err);
    endCall();
    showCallEndedUI('Call failed to start');
  }
}

async function establishPeerConnection(userId, isInitiator = false) {
  if (!isCallActive || peerConnections[userId]) return;

  const peerConnection = new RTCPeerConnection(ICE_CONFIG);
  peerConnections[userId] = peerConnection;

  // Add local tracks if we have them
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // ICE Candidate handling
  peerConnection.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('ice-candidate', { 
        candidate: e.candidate, 
        room, 
        callId: currentCallId,
        targetUser: userId
      });
    }
  };

  // Remote stream handling
  peerConnection.ontrack = e => {
    if (!e.streams || e.streams.length === 0) return;
    
    const stream = e.streams[0];
    remoteStreams[userId] = stream;
    
    // Add video element for this user
    if (currentCallType === 'video') {
      addVideoElement('remote', userId, stream);
    } else if (currentCallType === 'audio') {
      // For audio calls, we might want to show a placeholder
      addAudioElement(userId);
    }
  };

  // Connection state handling
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log(`Connection state with ${userId}: ${state}`);
    if (['disconnected', 'failed', 'closed'].includes(state)) {
      removePeerConnection(userId);
      if (Object.keys(peerConnections).length === 0) {
        endCall();
      }
    }
  };

  if (isInitiator) {
    // Create and send offer
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('offer', { 
        offer, 
        room, 
        callId: currentCallId,
        targetUser: userId
      });
    } catch (err) {
      console.error('Error creating offer:', err);
    }
  }

  // Process queued ICE candidates
  if (iceQueues[currentCallId] && iceQueues[currentCallId][userId]) {
    iceQueues[currentCallId][userId].forEach(candidate => {
      peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error('ICE error:', e));
    });
    iceQueues[currentCallId][userId] = [];
  }
}

function addAudioElement(userId) {
  const videoGrid = document.getElementById('video-grid');
  if (!videoGrid) return;

  const audioContainer = document.createElement('div');
  audioContainer.className = 'audio-container';
  audioContainer.id = `audio-container-${userId}`;

  const userLabel = document.createElement('div');
  userLabel.className = 'video-user-label';
  userLabel.textContent = userId === username ? 'You' : userId;

  const audioIcon = document.createElement('div');
  audioIcon.className = 'audio-icon';
  audioIcon.innerHTML = '<i class="fas fa-microphone"></i>';

  audioContainer.appendChild(audioIcon);
  audioContainer.appendChild(userLabel);
  videoGrid.appendChild(audioContainer);
}

function removePeerConnection(userId) {
  if (peerConnections[userId]) {
    peerConnections[userId].close();
    delete peerConnections[userId];
  }
  
  // Remove video/audio element if it exists
  const videoContainer = document.getElementById(`remote-container-${userId}`);
  if (videoContainer) videoContainer.remove();
  
  const audioContainer = document.getElementById(`audio-container-${userId}`);
  if (audioContainer) audioContainer.remove();
  
  delete remoteStreams[userId];
}

function endCall() {
  // Clean up all peer connections
  Object.keys(peerConnections).forEach(userId => {
    removePeerConnection(userId);
  });
  
  // Clean up local stream
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // Remove local video element
  const localVideoContainer = document.getElementById(`local-container-${username}`);
  if (localVideoContainer) localVideoContainer.remove();

  isCallActive = false;
  currentCallId = null;
  currentCallType = null;
  clearTimeout(callTimeout);
  hideCallUI();
  
  socket.emit('end-call', { room, callId: currentCallId });
}

// ======================
// Socket Event Handlers
// ======================

socket.on('connect', () => socket.emit('joinRoom', { username, room }));
socket.on('message', msg => {
  if (msg.username !== username && !isMuted) notificationSound.play().catch(() => {});
  addMessage(msg);
});
socket.on('showTyping', ({ username: u }) => u !== username && showTypingIndicator(u));
socket.on('stopTyping', () => document.querySelectorAll('.typing-indicator').forEach(el => el.remove()));
socket.on('incoming-call', handleIncomingCall);
socket.on('call-initiate', ({ callType, callId, caller }) => {
  if (callId === currentCallId) return; // Ignore our own call initiation
  
  if (isCallActive) {
    socket.emit('reject-call', { room, callId, reason: 'busy' });
    return;
  }
  
  handleIncomingCall({ callType, callId, caller });
});

socket.on('accept-call', async ({ userId, callId }) => {
  if (callId !== currentCallId || !isCallActive) return;
  
  // Establish peer connection with this user
  await establishPeerConnection(userId, true);
});

socket.on('offer', async ({ offer, userId, callId }) => {
  if (callId !== currentCallId || !isCallActive) return;
  
  // Check if we already have a connection with this user
  if (peerConnections[userId]) {
    console.log(`Already have connection with ${userId}, ignoring offer`);
    return;
  }
  
  // Establish peer connection with this user
  await establishPeerConnection(userId);
  
  const peerConnection = peerConnections[userId];
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('answer', { 
      answer, 
      room, 
      callId,
      targetUser: userId
    });
    
    // Process queued ICE candidates
    if (iceQueues[callId] && iceQueues[callId][userId]) {
      iceQueues[callId][userId].forEach(c => {
        peerConnection.addIceCandidate(new RTCIceCandidate(c))
          .catch(e => console.error('Error adding queued ICE candidate:', e));
      });
      iceQueues[callId][userId] = [];
    }
  } catch (err) {
    console.error('Offer handling error:', err);
  }
});

socket.on('answer', async ({ answer, userId, callId }) => {
  if (callId !== currentCallId || !isCallActive || !peerConnections[userId]) return;
  
  try {
    await peerConnections[userId].setRemoteDescription(new RTCSessionDescription(answer));
    
    // Process queued ICE candidates
    if (iceQueues[callId] && iceQueues[callId][userId]) {
      iceQueues[callId][userId].forEach(c => {
        peerConnections[userId].addIceCandidate(new RTCIceCandidate(c))
          .catch(e => console.error('Error adding queued ICE candidate:', e));
      });
      iceQueues[callId][userId] = [];
    }
  } catch (err) {
    console.error('Answer handling error:', err);
  }
});

socket.on('ice-candidate', ({ candidate, userId, callId }) => {
  if (callId !== currentCallId || !isCallActive) return;
  
  // Queue candidate if we don't have the connection yet
  if (!peerConnections[userId]) {
    if (!iceQueues[callId]) iceQueues[callId] = {};
    if (!iceQueues[callId][userId]) iceQueues[callId][userId] = [];
    iceQueues[callId][userId].push(candidate);
    return;
  }
  
  try {
    peerConnections[userId].addIceCandidate(new RTCIceCandidate(candidate))
      .catch(e => console.error('Error adding ICE candidate:', e));
  } catch (err) {
    console.error('Error processing ICE candidate:', err);
  }
});

socket.on('call-participants', ({ participants, callId }) => {
  if (callId !== currentCallId || !isCallActive) return;
  
  // Establish connections with all existing participants
  participants.forEach(async userId => {
    if (userId !== username && !peerConnections[userId]) {
      await establishPeerConnection(userId, true);
    }
  });
});

socket.on('user-joined-call', ({ userId }) => {
  if (!isCallActive || userId === username) return;
  // We'll establish connection when we receive their offer
});

socket.on('user-left-call', ({ userId }) => {
  if (!isCallActive) return;
  removePeerConnection(userId);
});

socket.on('end-call', () => {
  endCall();
  showCallEndedUI('Call ended');
});

socket.on('reject-call', ({ reason }) => {
  endCall();
  showCallEndedUI(reason === 'busy' ? 'User is busy' : 'Call rejected');
});

socket.on('mute-state', ({ userId, isAudioMuted: muted }) => {
  const userLabel = document.querySelector(`#remote-container-${userId} .video-user-label`);
  if (userLabel) {
    userLabel.innerHTML = `${userId === username ? 'You' : userId} ${muted ? '(muted)' : ''}`;
  }
});

socket.on('video-state', ({ userId, isVideoOff: videoOff }) => {
  const videoElem = document.getElementById(`remote-video-${userId}`);
  if (videoElem) {
    videoElem.style.display = videoOff ? 'none' : 'block';
  }
});

// ======================
// Event Listeners
// ======================

// Form submit
document.getElementById('chat-form').onsubmit = e => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('chatMessage', { text, replyTo, room });
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
};

// Initialize
videoCallBtn.onclick = () => startCall('video');
audioCallBtn.onclick = () => startCall('audio');
window.addEventListener('beforeunload', () => {
  if (isCallActive) socket.emit('end-call', { room, callId: currentCallId });
});

(function init() {
  if (!username || !room) return alert('Missing username or room!');
  initDarkMode();
  roomNameElem.textContent = room;
  setupSwipeToReply(); // Initialize swipe functionality
})();