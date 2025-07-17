// ✅ Complete Video/Voice Chat with Multi-User Support & Mirror Mode
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
const voiceCallBtn = document.getElementById('voice-call-btn');
const endCallBtn = document.getElementById('end-call-btn');
const videoCallContainer = document.getElementById('video-call-container');
const videoGrid = document.createElement('div');
videoGrid.id = 'video-grid';
videoCallContainer.appendChild(videoGrid);

const localVideo = document.createElement('video');
localVideo.muted = true;
localVideo.className = 'local-video';
videoGrid.appendChild(localVideo);

// Audio Elements
const notificationSound = new Audio('/sounds/notification.mp3');
const callSound = new Audio('/sounds/call.mp3');

// Query Params
const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true }) || {};

// State Variables
let replyTo = null;
let isMuted = localStorage.getItem('isMuted') === 'true';
let lastTypingUpdate = 0;
const SWIPE_THRESHOLD = 60;

// WebRTC Variables
const peers = {};
let localStream = null;
let currentCallId = null;
let callTimeout = null;
let isCallActive = false;
let callType = null; // 'video' or 'voice'
let iceQueue = [];
let isAudioMuted = false;
let isVideoOff = false;

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
const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});

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
// Call Functions
// ======================

function showCallingUI() {
  videoCallContainer.innerHTML = `
    <div class="calling-ui">
      <div class="calling-spinner"></div>
      <div class="calling-text">Calling...</div>
      <button id="cancel-call-btn" class="btn btn-danger"><i class="fas fa-phone-slash"></i> Cancel</button>
    </div>
  `;
  videoCallContainer.classList.remove('d-none');
  document.getElementById('cancel-call-btn').onclick = endCall;
  callSound.loop = true;
  callSound.play().catch(() => {});
}

function showCallUI() {
  callSound.pause();
  clearTimeout(callTimeout);

  videoCallContainer.innerHTML = `
    <div class="video-call-active">
      <div id="video-grid">
        ${callType === 'video' ? `<video id="local-video" autoplay playsinline muted class="local-video"></video>` : ''}
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
        </button>` : ''}
      </div>
    </div>
  `;

  videoCallContainer.classList.remove('d-none');

  // Setup control handlers
  document.getElementById('toggle-audio-btn').onclick = toggleAudio;
  if (callType === 'video') {
    document.getElementById('toggle-video-btn').onclick = toggleVideo;
  }
  document.getElementById('end-call-btn').onclick = endCall;

  if (callType === 'video') {
    const localV = document.getElementById('local-video');
    localV.srcObject = localStream;
    localV.style.transform = 'scaleX(-1)';
    localV.play().catch(e => console.error('Local video play error:', e));
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

// Media Control Functions
function updateMediaButtons() {
  const aBtn = document.getElementById('toggle-audio-btn');
  if (aBtn) aBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
  if (callType === 'video') {
    const vBtn = document.getElementById('toggle-video-btn');
    if (vBtn) vBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
  }
}

function toggleAudio() {
  isAudioMuted = !isAudioMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = !isAudioMuted);
  }
  updateMediaButtons();
}

function toggleVideo() {
  isVideoOff = !isVideoOff;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
  }
  updateMediaButtons();
}

// Call Management
async function startCall(type) {
  if (isCallActive) return;
  
  try {
    // Test permissions first
    const constraints = {
      audio: true,
      video: type === 'video' ? {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      } : false
    };
    
    const test = await navigator.mediaDevices.getUserMedia(constraints);
    test.getTracks().forEach(t => t.stop());
  } catch {
    return alert(`Please allow ${type === 'video' ? 'camera and microphone' : 'microphone'} access`);
  }

  isCallActive = true;
  callType = type;
  currentCallId = uuidv4();

  showCallingUI();
  showCallUI();

  try {
    const constraints = {
      audio: true,
      video: type === 'video' ? {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      } : false
    };
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    if (type === 'video') {
      const localV = document.getElementById('local-video');
      localV.srcObject = localStream;
      localV.style.transform = 'scaleX(-1)';
      localV.play().catch(e => console.error('Local video play error:', e));
    }

    socket.emit('call-initiate', { 
      room, 
      callId: currentCallId, 
      caller: username,
      callType: type
    });

    callTimeout = setTimeout(() => {
      if (Object.keys(peers).length === 0) {
        endCall();
        showCallEndedUI('No answer');
      }
    }, 30000);

  } catch (err) {
    console.error('Call setup error:', err);
    endCall();
    showCallEndedUI('Call failed to start');
  }
}

async function handleIncomingCall({ callId, caller, callType: remoteCallType }) {
  if (isCallActive) {
    socket.emit('reject-call', { room, callId, reason: 'busy' });
    return;
  }

  const accept = confirm(`${caller} is ${remoteCallType === 'video' ? 'video' : 'voice'} calling. Accept?`);
  if (!accept) {
    socket.emit('reject-call', { room, callId });
    return;
  }

  isCallActive = true;
  callType = remoteCallType;
  currentCallId = callId;

  try {
    const constraints = {
      audio: true,
      video: callType === 'video' ? {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      } : false
    };
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    showCallUI();

    if (callType === 'video') {
      const localV = document.getElementById('local-video');
      localV.srcObject = localStream;
      localV.style.transform = 'scaleX(-1)';
      localV.play().catch(e => console.error('Local video play error:', e));
    }

    socket.emit('accept-call', { room, callId });

  } catch (err) {
    console.error('Media access error:', err);
    endCall();
  }
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
      socket.emit('ice-candidate', { candidate: e.candidate, peerId, room, callId: currentCallId });
    }
  };

  // Remote stream handling
  pc.ontrack = e => {
    if (!e.streams || e.streams.length === 0) return;
    
    if (remoteCallType === 'video') {
      addRemoteStream(peerId, e.streams[0], remoteUsername);
    } else {
      // For voice calls, just play the audio
      const audio = new Audio();
      audio.srcObject = e.streams[0];
      audio.play().catch(e => console.error('Audio play error:', e));
    }
  };

  // Connection state handling
  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed'].includes(pc.connectionState)) {
      if (remoteCallType === 'video') {
        removeVideoElement(peerId);
      }
      delete peers[peerId];
    }
  };

  return pc;
}

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
  document.getElementById('video-grid').appendChild(videoContainer);
}

function removeVideoElement(peerId) {
  const elem = document.getElementById(`video-${peerId}`);
  if (elem) elem.remove();
}

function endCall() {
  // Close all peer connections
  Object.values(peers).forEach(peer => peer.close());
  Object.keys(peers).forEach(peerId => removeVideoElement(peerId));
  
  // Clean up local stream
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // Reset state
  isCallActive = false;
  callType = null;
  currentCallId = null;
  clearTimeout(callTimeout);
  peers = {};
  
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

socket.on('call-accepted', async ({ peerId, username: remoteUsername, callType: remoteCallType }) => {
  if (!isCallActive || !localStream) return;
  
  const pc = setupPeerConnection(peerId, remoteUsername, remoteCallType);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { offer, peerId, room, callId: currentCallId, callType });
  } catch (err) {
    console.error('Offer creation error:', err);
  }
});

socket.on('offer', async ({ offer, peerId, username: remoteUsername, callType: remoteCallType }) => {
  if (!isCallActive || !localStream) return;
  
  const pc = setupPeerConnection(peerId, remoteUsername, remoteCallType);
  try {
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { answer, peerId, room, callId: currentCallId, callType });
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
  if (peerId === socket.id) return;
  
  const pc = peers[peerId];
  if (pc && candidate) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.error('ICE candidate error:', err);
    }
  }
});

socket.on('end-call', () => {
  endCall();
  showCallEndedUI('Call ended');
});

socket.on('reject-call', ({ reason }) => {
  endCall();
  showCallEndedUI(reason === 'busy' ? 'User is busy' : 'Call rejected');
});

// ======================
// Event Listeners
// ======================

// Form submit
document.getElementById('chat-form').onsubmit = e => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('chatMessage', { text, replyTo, room, username });
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
};

// Call buttons
videoCallBtn.onclick = () => startCall('video');
voiceCallBtn.onclick = () => startCall('voice');
endCallBtn.onclick = endCall;

// Cleanup on exit
window.addEventListener('beforeunload', () => {
  if (isCallActive) {
    socket.emit('end-call', { room, callId: currentCallId });
  }
});

// Initialize
(function init() {
  if (!username || !room) return alert('Missing username or room!');
  initDarkMode();
  roomNameElem.textContent = room;
})();