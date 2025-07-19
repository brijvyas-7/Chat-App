
// ✅ Fixed WebRTC Implementation - Proper Video Display & UI Positioning
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
const videoCallContainer = document.getElementById('video-call-container');

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
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let currentCallId = null;
let callTimeout = null;
let isCallActive = false;
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
// Video Call Functions
// ======================

// Video UI Functions
function showCallingUI() {
  videoCallContainer.innerHTML = `
    <div class="calling-ui">
      <div class="calling-spinner"></div>
      <div class="calling-text">Calling...</div>
      <button id="cancel-call-btn" class="btn btn-danger"><i class="fas fa-phone-slash"></i> Cancel</button>
    </div>
  `;
  videoCallContainer.classList.remove('d-none');
  document.getElementById('cancel-call-btn').onclick = endVideoCall;
  callSound.loop = true; 
  callSound.play().catch(() => {});
}

function showVideoCallUI() {
  callSound.pause();
  clearTimeout(callTimeout);

  videoCallContainer.innerHTML = `
    <div class="video-call-active">
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
    </div>
  `;

  videoCallContainer.classList.remove('d-none');

  // Setup control handlers
  document.getElementById('toggle-audio-btn').onclick = toggleAudio;
  document.getElementById('toggle-video-btn').onclick = toggleVideo;
  document.getElementById('end-call-btn').onclick = endVideoCall;

  return {
    localV: document.getElementById('local-video'),
    remoteV: document.getElementById('remote-video')
  };
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
  const vBtn = document.getElementById('toggle-video-btn');
  if (aBtn) aBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
  if (vBtn) vBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
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
async function startVideoCall() {
  if (isCallActive) return;
  
  try {
    // Test permissions first
    const test = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    test.getTracks().forEach(t => t.stop());
  } catch {
    return alert('Please allow camera and microphone access to start a call.');
  }

  isCallActive = true;
  currentCallId = uuidv4();
  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  showCallingUI();
  const { localV } = showVideoCallUI();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localV.srcObject = localStream;
    localV.play().catch(e => console.error('Local video play error:', e));

    // Add tracks to connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // ICE Candidate handling
    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('ice-candidate', { candidate: e.candidate, room, callId: currentCallId });
      }
    };

    // Remote stream handling
    peerConnection.ontrack = e => {
      if (!e.streams || e.streams.length === 0) return;
      
      const remoteV = document.getElementById('remote-video');
      if (!remoteV.srcObject) {
        remoteV.srcObject = e.streams[0];
      } else {
        e.streams[0].getTracks().forEach(track => {
          if (!remoteV.srcObject.getTracks().some(t => t.id === track.id)) {
            remoteV.srcObject.addTrack(track);
          }
        });
      }
      
      remoteV.onloadedmetadata = () => {
        remoteV.play().catch(e => console.error('Remote video play error:', e));
      };
    };

    // Connection state handling
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (['disconnected', 'failed', 'closed'].includes(state)) {
        endVideoCall();
        showCallEndedUI('Call disconnected');
      }
    };

    // Create and send offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('video-call-initiate', { 
      offer, 
      room, 
      callId: currentCallId, 
      caller: username 
    });

    // Set timeout for no answer
    callTimeout = setTimeout(() => {
      if (!document.getElementById('remote-video')?.srcObject) {
        endVideoCall();
        showCallEndedUI('No answer');
      }
    }, 30000);

  } catch (err) {
    console.error('Call setup error:', err);
    endVideoCall();
    showCallEndedUI('Call failed to start');
  }
}

async function handleIncomingCall({ offer, callId, caller }) {
  if (isCallActive) {
    socket.emit('reject-call', { room, callId, reason: 'busy' });
    return;
  }

  const accept = confirm(`${caller} is calling. Accept?`);
  if (!accept) {
    socket.emit('reject-call', { room, callId });
    return;
  }

  isCallActive = true;
  currentCallId = callId;

  try {
    const { localV, remoteV } = showVideoCallUI();
    peerConnection = new RTCPeerConnection(ICE_CONFIG);

    // Setup remote stream handling
    peerConnection.ontrack = e => {
      if (!e.streams || e.streams.length === 0) return;
      
      if (!remoteV.srcObject) {
        remoteV.srcObject = e.streams[0];
      } else {
        e.streams[0].getTracks().forEach(track => {
          if (!remoteV.srcObject.getTracks().some(t => t.id === track.id)) {
            remoteV.srcObject.addTrack(track);
          }
        });
      }
      
      remoteV.onloadedmetadata = () => {
        remoteV.play().catch(e => console.error('Remote video play error:', e));
      };
    };

    // Get local media
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localV.srcObject = localStream;
    localV.play().catch(e => console.error('Local video play error:', e));

    // Add local tracks
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // ICE Candidate handling
    peerConnection.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('ice-candidate', { candidate: e.candidate, room, callId });
      }
    };

    // Connection state handling
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (['disconnected', 'failed', 'closed'].includes(state)) {
        endVideoCall();
        showCallEndedUI('Call disconnected');
      }
    };

    // Process the offer
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('video-answer', { answer, room, callId });

    // Process queued ICE candidates
    iceQueue.forEach(candidate => {
      peerConnection.addIceCandidate(candidate).catch(e => console.error('ICE error:', e));
    });
    iceQueue = [];

  } catch (err) {
    console.error('Call setup error:', err);
    endVideoCall();
    showCallEndedUI('Call failed to start');
  }
}

function endVideoCall() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
    remoteStream = null;
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  isCallActive = false;
  currentCallId = null;
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
socket.on('video-answer', async ({ answer, callId }) => {
  if (callId !== currentCallId || !peerConnection) return;
  try {
    await peerConnection.setRemoteDescription(answer);
    iceQueue.forEach(c => peerConnection.addIceCandidate(c));
    iceQueue = [];
  } catch (err) {
    console.error('Answer handling error:', err);
  }
});
socket.on('ice-candidate', ({ candidate, callId }) => {
  if (callId !== currentCallId || !peerConnection) {
    iceQueue.push(candidate);
  } else {
    peerConnection.addIceCandidate(candidate).catch(console.error);
  }
});
socket.on('end-call', () => endVideoCall());
socket.on('reject-call', ({ reason }) => {
  endVideoCall();
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
  socket.emit('chatMessage', { text, replyTo, room });
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
};

// Initialize
videoCallBtn.onclick = () => startVideoCall();
window.addEventListener('beforeunload', () => {
  if (isCallActive) socket.emit('end-call', { room, callId: currentCallId });
});

(function init() {
  if (!username || !room) return alert('Missing username or room!');
  initDarkMode();
  roomNameElem.textContent = room;
})();
