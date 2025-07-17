// ✅ Complete Video/Voice Chat with Multi-User Support
const socket = io({ reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });

// DOM Elements
const msgInput = document.getElementById('msg');
const chatMessages = document.getElementById('chat-messages');
const videoGrid = document.getElementById('video-grid');
const videoCallBtn = document.getElementById('video-call-btn');
const voiceCallBtn = document.getElementById('voice-call-btn');
const endCallBtn = document.getElementById('end-call-btn');
const localVideo = document.createElement('video');
localVideo.muted = true;
localVideo.className = 'local-video';

// State Management
const peers = {};
let localStream;
let isCallActive = false;
let callType = null; // 'video' or 'voice'
let isMuted = localStorage.getItem('isMuted') === 'true';
const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true }) || {};

// WebRTC Configuration
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};

// Initialize
(function init() {
  if (!username || !room) return alert('Missing username or room!');
  document.getElementById('room-name').textContent = room;
  videoGrid.appendChild(localVideo);
  setupEventListeners();
})();

// ======================
// Core Call Functions
// ======================

async function startCall(type) {
  if (isCallActive) return;
  
  try {
    // Get media based on call type
    localStream = await navigator.mediaDevices.getUserMedia({ 
      video: type === 'video' ? { 
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      } : false,
      audio: true
    });

    callType = type;
    isCallActive = true;
    
    // Setup UI based on call type
    if (type === 'video') {
      localVideo.style.transform = 'scaleX(-1)';
      localVideo.srcObject = localStream;
      localVideo.style.display = 'block';
    } else {
      localVideo.style.display = 'none';
    }

    socket.emit('join-call', { room, username, callType: type });
    toggleCallUI(true);
  } catch (err) {
    console.error('Media access failed:', err);
    alert(`Could not access ${type === 'video' ? 'camera' : 'microphone'}`);
  }
}

function endCall() {
  // Close all peer connections
  Object.values(peers).forEach(peer => peer.close());
  Object.keys(peers).forEach(peerId => removeVideoElement(peerId));
  
  // Clean up local stream
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localVideo.srcObject = null;
  }
  
  socket.emit('leave-call', { room });
  isCallActive = false;
  callType = null;
  toggleCallUI(false);
}

function setupPeerConnection(peerId, remoteUsername, remoteCallType) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[peerId] = pc;

  // Add local tracks
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  // ICE Candidate handling
  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('ice-candidate', { candidate: e.candidate, peerId, room });
    }
  };

  // Remote stream handling
  pc.ontrack = e => {
    if (!e.streams || e.streams.length === 0) return;
    
    if (remoteCallType === 'video') {
      addRemoteStream(peerId, e.streams[0], remoteUsername);
    } else {
      // Voice-only call - just play audio
      const audio = new Audio();
      audio.srcObject = e.streams[0];
      audio.play().catch(console.error);
    }
  };

  // Connection state handling
  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed'].includes(pc.connectionState)) {
      removeVideoElement(peerId);
      delete peers[peerId];
    }
  };

  return pc;
}

// ======================
// UI Functions
// ======================

function addRemoteStream(peerId, stream, username) {
  if (document.getElementById(`video-${peerId}`)) return;

  const videoContainer = document.createElement('div');
  videoContainer.id = `video-${peerId}`;
  videoContainer.className = 'remote-video-container';
  
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  
  const usernameLabel = document.createElement('div');
  usernameLabel.className = 'username-label';
  usernameLabel.textContent = username || `User ${peerId.slice(0, 5)}`;
  
  videoContainer.appendChild(video);
  videoContainer.appendChild(usernameLabel);
  videoGrid.appendChild(videoContainer);
}

function removeVideoElement(peerId) {
  const elem = document.getElementById(`video-${peerId}`);
  if (elem) elem.remove();
}

function toggleCallUI(callActive) {
  videoCallBtn.style.display = callActive ? 'none' : 'block';
  voiceCallBtn.style.display = callActive ? 'none' : 'block';
  endCallBtn.style.display = callActive ? 'block' : 'none';
}

// ======================
// Socket Event Handlers
// ======================

function setupSocketEvents() {
  // Connection
  socket.on('connect', () => socket.emit('joinRoom', { username, room }));

  // Chat messages
  socket.on('message', msg => {
    if (msg.username !== username && !isMuted) {
      new Audio('/sounds/notification.mp3').play().catch(() => {});
    }
    addMessage(msg);
  });

  // Call management
  socket.on('user-joined', async ({ peerId, username: remoteUsername, callType: remoteCallType }) => {
    if (peerId === socket.id || !localStream) return;
    
    const pc = setupPeerConnection(peerId, remoteUsername, remoteCallType);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { offer, peerId, room, callType });
    } catch (err) {
      console.error('Offer creation error:', err);
    }
  });

  socket.on('offer', async ({ offer, peerId, username: remoteUsername, callType: remoteCallType }) => {
    if (!localStream) return;
    
    const pc = setupPeerConnection(peerId, remoteUsername, remoteCallType);
    try {
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { answer, peerId, room, callType });
    } catch (err) {
      console.error('Answer handling error:', err);
    }
  });

  socket.on('answer', async ({ answer, peerId }) => {
    const pc = peers[peerId];
    if (pc) {
      try {
        await pc.setRemoteDescription(answer);
      } catch (err) {
        console.error('Answer processing error:', err);
      }
    }
  });

  socket.on('ice-candidate', async ({ candidate, peerId }) => {
    const pc = peers[peerId];
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.error('ICE candidate error:', err);
      }
    }
  });

  socket.on('user-left', ({ peerId }) => {
    if (peers[peerId]) {
      peers[peerId].close();
      delete peers[peerId];
    }
    removeVideoElement(peerId);
  });

  // Typing indicators
  socket.on('showTyping', ({ username: u }) => u !== username && showTypingIndicator(u));
  socket.on('stopTyping', () => document.querySelectorAll('.typing-indicator').forEach(el => el.remove()));
}

// ======================
// Event Listeners
// ======================

function setupEventListeners() {
  // Call buttons
  videoCallBtn.addEventListener('click', () => startCall('video'));
  voiceCallBtn.addEventListener('click', () => startCall('voice'));
  endCallBtn.addEventListener('click', endCall);
  
  // Theme toggle
  themeBtn.addEventListener('click', () => {
    const isDark = !document.body.classList.toggle('dark');
    localStorage.setItem('darkMode', isDark);
    chatMessages.classList.toggle('dark-bg', isDark);
  });

  // Mute toggle
  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    localStorage.setItem('isMuted', isMuted);
    muteBtn.innerHTML = isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';
  });

  // Chat form
  document.getElementById('chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text) return;
    socket.emit('chatMessage', { text, replyTo, room, username });
    msgInput.value = '';
    replyTo = null;
    replyPreview.classList.add('d-none');
  });

  // Cleanup on exit
  window.addEventListener('beforeunload', () => {
    if (isCallActive) {
      socket.emit('leave-call', { room });
    }
  });
}

// ======================
// Chat Functions (Preserved)
// ======================

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

function showTypingIndicator(user) {
  if (!document.querySelector('.typing-indicator')) {
    const d = document.createElement('div');
    d.className = 'typing-indicator other';
    d.innerHTML = `<div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><span class="typing-text">${user} is typing...</span>`;
    chatMessages.appendChild(d);
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
  }
}

// Initialize everything
setupSocketEvents();