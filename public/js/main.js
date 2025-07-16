// main.js

// ==============================
// 1. Socket.IO & Initial Setup
// ==============================
const socket = io({
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000
});

// DOM Elements
const msgInput           = document.getElementById('msg');
const chatMessages       = document.getElementById('chat-messages');
const replyPreview       = document.getElementById('reply-preview');
const replyUserElem      = document.getElementById('reply-user');
const replyTextElem      = document.getElementById('reply-text');
const cancelReplyBtn     = document.getElementById('cancel-reply');
const themeBtn           = document.getElementById('theme-toggle');
const muteBtn            = document.getElementById('mute-toggle');
const roomNameElem       = document.getElementById('room-name');
const videoCallBtn       = document.getElementById('video-call-btn');
const videoCallContainer = document.getElementById('video-call-container');
const notificationSound  = new Audio('/sounds/notification.mp3');
const callSound          = new Audio('/sounds/call.mp3');

const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true }) || {};

// ==============================
// 2. State Variables
// ==============================
let replyTo           = null;
let isMuted           = localStorage.getItem('isMuted') === 'true';
let lastTypingUpdate  = 0;
const SWIPE_THRESHOLD = 60;

// WebRTC / Video-call
let peerConnection, localStream, remoteStream;
let currentCallId = null;
let callTimeout   = null;
let isCallActive  = false;
let iceQueue      = [];
let isAudioMuted  = false;
let isVideoOff    = false;

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// UUID helper
const uuidv4 = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0,
          v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });

// ==============================
// 3. Dark Mode & Theme
// ==============================
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

// ==============================
// 4. Reply Preview Functionality
// ==============================
function setupReply(user, msgID, text) {
  replyTo = { id: msgID, username: user, text };
  replyUserElem.textContent = user;
  replyTextElem.textContent = text.length > 30
    ? text.substring(0, 30) + '…'
    : text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();
}

cancelReplyBtn.addEventListener('click', e => {
  e.stopPropagation();
  replyTo = null;
  replyPreview.classList.add('d-none');
});

// ==============================
// 5. Message Rendering & Swipe
// ==============================
function addMessage(msg) {
  // Remove typing indicator if present
  const typingElem = document.querySelector('.typing-indicator');
  if (typingElem) typingElem.remove();

  const div = document.createElement('div');
  const isMe = msg.username === username;
  const isSystem = msg.username === 'ChatApp Bot';

  div.id = msg.id;
  div.className = `message ${isMe ? 'you' : 'other'}${isSystem ? ' system' : ''}`;

  let html = '';
  if (msg.replyTo) {
    html += `
      <div class="message-reply">
        <span class="reply-sender">${msg.replyTo.username}</span>
        <span class="reply-text">${msg.replyTo.text}</span>
      </div>`;
  }

  html += `
    <div class="meta">
      ${isMe && !document.body.classList.contains('dark') ? '<span class="prompt-sign">></span>' : ''}
      <strong>${msg.username}</strong>
      <span class="message-time">${msg.time}</span>
    </div>
    <div class="text">${msg.text}</div>
  `;

  if (isMe) {
    const seenNames = msg.seenBy?.length > 0
      ? msg.seenBy.map(u => u === username ? 'You' : u).join(', ')
      : '';
    html += `
      <div class="message-status">
        <span class="seen-icon">${seenNames ? '✓✓' : '✓'}</span>
        ${seenNames ? `<span class="seen-users">${seenNames}</span>` : ''}
      </div>
    `;
  }

  div.innerHTML = html;

  // Swipe-to-reply (light mode only)
  if (!document.body.classList.contains('dark')) {
    setupSwipeHandler(div);
  }

  // Click-to-reply on desktop
  div.addEventListener('click', () => {
    if (window.innerWidth > 768 && !isSystem) {
      const user = div.querySelector('.meta strong')?.textContent;
      const text = div.querySelector('.text')?.textContent;
      if (user && text) setupReply(user, div.id, text);
    }
  });

  chatMessages.appendChild(div);
  setTimeout(() => {
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
  }, 50);
}

function setupSwipeHandler(el) {
  let startX = 0;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    const diffX = e.touches[0].clientX - startX;
    if (diffX > 0 && diffX < 100) {
      e.preventDefault();
      el.style.transform = `translateX(${diffX}px)`;
    }
  }, { passive: false });

  el.addEventListener('touchend', e => {
    const diffX = e.changedTouches[0].clientX - startX;
    if (diffX > SWIPE_THRESHOLD) el.click();
    el.style.transform = '';
  }, { passive: true });
}

// ==============================
// 6. Typing Indicators
// ==============================
msgInput.addEventListener('input', () => {
  const now = Date.now();
  if (now - lastTypingUpdate > 1000) {
    socket.emit('typing', { room });
    lastTypingUpdate = now;
  }
  clearTimeout(window._stopTypingTimeout);
  window._stopTypingTimeout = setTimeout(() => {
    socket.emit('stopTyping', { room });
  }, 2000);
});

function showTypingIndicator(user) {
  if (document.querySelector('.typing-indicator')) {
    document.querySelector('.typing-indicator').remove();
  }
  const div = document.createElement('div');
  div.className = `typing-indicator other`;
  div.innerHTML = `
    <div class="dots">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
    </div>
    <span class="typing-text">${user} is typing…</span>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
}

// ==============================
// 7. Seen Receipts
// ==============================
function markMessagesAsSeen() {
  const seenIds = Array.from(chatMessages.querySelectorAll('.message.you'))
    .map(el => el.id)
    .filter(Boolean);
  if (seenIds.length) {
    socket.emit('markAsSeen', { messageIds: seenIds, room });
  }
}

// ==============================
// 8. Dark/Light & Mute Toggles
// ==============================
themeBtn.addEventListener('click', () => {
  const isDark = !document.body.classList.contains('dark');
  document.body.classList.toggle('dark', isDark);
  localStorage.setItem('darkMode', isDark);
  updateThemeIcon(isDark);
  updateBackgroundColors(isDark);
});

muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('isMuted', isMuted);
});

// ==============================
// 9. Video-Call UI Helpers
// ==============================
function showCallingUI() {
  videoCallContainer.innerHTML = `
    <div class="calling-ui">
      <div class="calling-spinner"></div>
      <div class="calling-text">Calling…</div>
      <button id="cancel-call-btn" class="btn btn-danger">
        <i class="fas fa-phone-slash"></i> Cancel
      </button>
    </div>`;
  videoCallContainer.classList.remove('d-none');
  document.getElementById('cancel-call-btn').onclick = endVideoCall;
  callSound.loop = true;
  callSound.play().catch(() => {});
}

function showVideoCallUI() {
  callSound.pause();
  callSound.currentTime = 0;
  clearTimeout(callTimeout);

  videoCallContainer.innerHTML = `
    <div class="video-container">
      <video id="remote-video" autoplay playsinline class="remote-video"></video>
      <video id="local-video"  autoplay playsinline muted  class="local-video"></video>
    </div>
    <div class="video-controls">
      <button id="toggle-audio-btn" class="control-btn audio-btn">
        <i class="fas fa-microphone"></i>
      </button>
      <button id="end-call-btn"    class="control-btn end-btn">
        <i class="fas fa-phone-slash"></i>
      </button>
      <button id="toggle-video-btn"class="control-btn video-btn">
        <i class="fas fa-video"></i>
      </button>
    </div>`;

  document.getElementById('toggle-audio-btn').onclick = toggleAudio;
  document.getElementById('toggle-video-btn').onclick = toggleVideo;
  document.getElementById('end-call-btn').onclick    = endVideoCall;
}

function hideCallUI() {
  videoCallContainer.classList.add('d-none');
  callSound.pause();
  callSound.currentTime = 0;
  clearTimeout(callTimeout);
}

function showCallEndedUI(message) {
  const alertBox = document.createElement('div');
  alertBox.className = 'call-ended-alert';
  alertBox.innerHTML = `
    <div class="alert-content">
      <p>${message}</p>
      <button id="close-alert-btn" class="btn btn-primary">OK</button>
    </div>`;
  document.body.appendChild(alertBox);
  document.getElementById('close-alert-btn').onclick = () => alertBox.remove();
}

// ==============================
// 10. Media Control Buttons
// ==============================
function updateMediaButtons() {
  const audioBtn = document.getElementById('toggle-audio-btn');
  const videoBtn = document.getElementById('toggle-video-btn');
  if (audioBtn) audioBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
  if (videoBtn) videoBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
}

function toggleAudio() {
  isAudioMuted = !isAudioMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isAudioMuted);
  updateMediaButtons();
}

function toggleVideo() {
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
  updateMediaButtons();
}

// ==============================
// 11. Video-Call Logic
// ==============================
async function startVideoCall() {
  if (isCallActive) return;
  // check permissions
  try {
    const testStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    testStream.getTracks().forEach(t => t.stop());
  } catch {
    return alert('Please allow camera and microphone access.');
  }

  isCallActive  = true;
  currentCallId = uuidv4();
  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  // get local media
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
    audio: { noiseSuppression: true, echoCancellation: true }
  });

  // show calling spinner + UI
  showCallingUI();
  showVideoCallUI();
  document.getElementById('local-video').srcObject = localStream;

  // add tracks
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  // ICE candidate handler
  peerConnection.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('ice-candidate', {
        candidate: e.candidate,
        room,
        callId: currentCallId
      });
    }
  };

  // remote track handler
  peerConnection.ontrack = event => {
    if (!event.streams || !event.streams[0]) return;
    remoteStream = event.streams[0];
    const remoteVid = document.getElementById('remote-video');
    remoteVid.srcObject = remoteStream;
  };

  // connection state
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') {
      // connected, nothing
    } else if (['disconnected','failed'].includes(peerConnection.connectionState)) {
      endVideoCall();
      showCallEndedUI('Call disconnected');
    }
  };

  // create offer
  const offer = await peerConnection.createOffer({ offerToReceiveVideo: true });
  await peerConnection.setLocalDescription(offer);

  // send offer
  socket.emit('video-call-initiate', {
    offer,
    room,
    callId: currentCallId,
    caller: username
  });

  // set timeout
  callTimeout = setTimeout(() => {
    if (!remoteStream) {
      endVideoCall();
      showCallEndedUI('No answer');
    }
  }, 30000);
}

async function handleIncomingCall({ offer, callId, caller }) {
  if (peerConnection || isCallActive) {
    socket.emit('reject-call', { room, callId, reason: 'busy' });
    return;
  }

  const accept = confirm(`${caller} is calling. Accept?`);
  if (!accept) {
    socket.emit('reject-call', { room, callId });
    return;
  }

  isCallActive  = true;
  currentCallId = callId;
  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  // get local media
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  showVideoCallUI();
  document.getElementById('local-video').srcObject = localStream;

  // add tracks
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('ice-candidate', { candidate: e.candidate, room, callId });
    }
  };

  peerConnection.ontrack = event => {
    remoteStream = event.streams[0];
    document.getElementById('remote-video').srcObject = remoteStream;
  };

  peerConnection.onconnectionstatechange = () => {
    if (['disconnected','failed'].includes(peerConnection.connectionState)) {
      endVideoCall();
      showCallEndedUI('Call disconnected');
    }
  };

  // answer
  await peerConnection.setRemoteDescription(offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('video-answer', { answer, room, callId });

  // flush ICE queue
  iceQueue.forEach(c => peerConnection.addIceCandidate(c));
  iceQueue = [];
}

function endVideoCall() {
  // stop media
  [localStream, remoteStream].forEach(s => {
    if (s) s.getTracks().forEach(t => t.stop());
  });
  peerConnection?.close();
  peerConnection = null;

  hideCallUI();
  socket.emit('end-call', { room, callId: currentCallId });

  isCallActive  = false;
  currentCallId = null;
  iceQueue      = [];
}

// ==============================
// 12. Socket Event Handlers
// ==============================
socket.on('connect', () => {
  socket.emit('joinRoom', { username, room });
});

socket.on('message', msg => {
  if (msg.username !== username && !isMuted) {
    notificationSound.play().catch(() => {});
  }
  addMessage(msg);
});

socket.on('userJoined', data => {
  addMessage({
    id: 'sys-' + Date.now(),
    username: 'ChatApp Bot',
    text: `${data.username} has joined the chat`,
    time: data.time
  });
});

socket.on('userLeft', data => {
  addMessage({
    id: 'sys-' + Date.now(),
    username: 'ChatApp Bot',
    text: `${data.username} has left`,
    time: data.time
  });
});

socket.on('showTyping', ({ username: u }) => {
  if (u !== username) showTypingIndicator(u);
});

socket.on('stopTyping', () => {
  const ti = document.querySelector('.typing-indicator');
  if (ti) ti.remove();
});

socket.on('messagesSeen', updates => {
  updates.forEach(u => {
    const m = document.getElementById(u.messageId);
    if (!m) return;
    const status = m.querySelector('.message-status');
    if (!status) return;
    const seen = u.seenBy.map(x => x === username ? 'You' : x).join(', ');
    status.innerHTML = `
      <span class="seen-icon">${u.seenBy.length>1?'✓✓':'✓'}</span>
      ${seen?`<span class="seen-users">${seen}</span>`:''}
    `;
  });
});

socket.on('incoming-call', handleIncomingCall);

socket.on('video-answer', async ({ answer, callId }) => {
  if (callId !== currentCallId) return;
  await peerConnection.setRemoteDescription(answer);
  iceQueue.forEach(c => peerConnection.addIceCandidate(c));
  iceQueue = [];
});

socket.on('ice-candidate', ({ candidate, callId }) => {
  if (callId !== currentCallId) return iceQueue.push(candidate);
  peerConnection.addIceCandidate(candidate).catch(console.error);
});

socket.on('end-call', () => endVideoCall());

socket.on('reject-call', ({ reason }) => {
  endVideoCall();
  showCallEndedUI(reason === 'busy' ? 'User is busy' : 'Call rejected');
});

// ==============================
// 13. UI Event Listeners & Init
// ==============================
document.getElementById('chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('chatMessage', { text, replyTo, room });
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
});

videoCallBtn.addEventListener('click', () => startVideoCall());

window.addEventListener('beforeunload', () => {
  if (isCallActive) {
    socket.emit('end-call', { room, callId: currentCallId });
  }
});

// iOS keyboard fix
if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
  window.addEventListener('resize', () => {
    document.querySelector('header').style.position = 'sticky';
  });
}

// Initialize
function init() {
  if (!username || !room) {
    return alert('Missing username or room');
  }
  initDarkMode();
  roomNameElem.textContent = room;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
init();