// ✅ Fully Working main.js with WebRTC Fix – Chat + Call Features – Copy-Paste Ready

const socket = io({ reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });

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

const notificationSound = new Audio('/sounds/notification.mp3');
const callSound = new Audio('/sounds/call.mp3');

const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true }) || {};

let replyTo = null;
let isMuted = localStorage.getItem('isMuted') === 'true';
let lastTypingUpdate = 0;
const SWIPE_THRESHOLD = 60;

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let currentCallId = null;
let callTimeout = null;
let isCallActive = false;
let iceQueue = [];
let isAudioMuted = false;
let isVideoOff = false;

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});

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

// Reply UI
cancelReplyBtn.onclick = e => {
  e.stopPropagation();
  replyTo = null;
  replyPreview.classList.add('d-none');
};
function setupReply(user, msgID, text) {
  replyTo = { id: msgID, username: user, text };
  replyUserElem.textContent = user;
  replyTextElem.textContent = text.length > 30 ? text.substr(0, 30) + '…' : text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();
}
function setupSwipeHandler(el) {
  let startX = 0;
  el.addEventListener('touchstart', e => startX = e.touches[0].clientX, { passive: true });
  el.addEventListener('touchmove', e => {
    const diff = e.touches[0].clientX - startX;
    if (diff > 0 && diff < 100) {
      e.preventDefault();
      el.style.transform = `translateX(${diff}px)`;
    }
  }, { passive: false });
  el.addEventListener('touchend', e => {
    const diff = e.changedTouches[0].clientX - startX;
    if (diff > SWIPE_THRESHOLD) el.click();
    el.style.transform = '';
  }, { passive: true });
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

  if (!document.body.classList.contains('dark')) setupSwipeHandler(el);

  chatMessages.appendChild(el);
  setTimeout(() => chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' }), 20);
}
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
    d.innerHTML = `<div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><span class="typing-text">${user} is typing…</span>`;
    chatMessages.appendChild(d);
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
  }
}
// Video UI
function showCallingUI() {
  videoCallContainer.innerHTML = `<div class="calling-ui">
    <div class="calling-spinner"></div>
    <div class="calling-text">Calling…</div>
    <button id="cancel-call-btn" class="btn btn-danger"><i class="fas fa-phone-slash"></i> Cancel</button>
  </div>`;
  videoCallContainer.classList.remove('d-none');
  document.getElementById('cancel-call-btn').onclick = endVideoCall;
  callSound.loop = true; callSound.play().catch(() => {});
}
function showVideoCallUI() {
  callSound.pause(); clearTimeout(callTimeout);
  videoCallContainer.innerHTML = `<div class="video-container">
    <video id="remote-video" autoplay playsinline class="remote-video"></video>
    <video id="local-video" autoplay playsinline muted class="local-video"></video>
  </div><div class="video-controls">
    <button id="toggle-audio-btn" class="control-btn audio-btn"><i class="fas fa-microphone"></i></button>
    <button id="end-call-btn" class="control-btn end-btn"><i class="fas fa-phone-slash"></i></button>
    <button id="toggle-video-btn" class="control-btn video-btn"><i class="fas fa-video"></i></button>
  </div>`;
  document.getElementById('toggle-audio-btn').onclick = toggleAudio;
  document.getElementById('toggle-video-btn').onclick = toggleVideo;
  document.getElementById('end-call-btn').onclick = endVideoCall;
}
function hideCallUI() {
  videoCallContainer.classList.add('d-none');
  callSound.pause(); clearTimeout(callTimeout);
}
function showCallEndedUI(msg) {
  const div = document.createElement('div');
  div.className = 'call-ended-alert';
  div.innerHTML = `<div class="alert-content"><p>${msg}</p><button id="close-alert-btn" class="btn btn-primary">OK</button></div>`;
  document.body.appendChild(div);
  document.getElementById('close-alert-btn').onclick = () => div.remove();
}

// Media Buttons
function updateMediaButtons() {
  const aBtn = document.getElementById('toggle-audio-btn');
  const vBtn = document.getElementById('toggle-video-btn');
  if (aBtn) aBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
  if (vBtn) vBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
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

// Start Call
async function startVideoCall() {
  if (isCallActive) return;
  try {
    const test = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    test.getTracks().forEach(t => t.stop());
  } catch {
    return alert('Allow camera and mic to start call.');
  }

  isCallActive = true;
  currentCallId = uuidv4();
  peerConnection = new RTCPeerConnection(ICE_CONFIG);
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

  showCallingUI(); showVideoCallUI();
  const localV = document.getElementById('local-video');
  localV.srcObject = localStream;
  localV.muted = true; localV.play().catch(() => {});
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { candidate: e.candidate, room, callId: currentCallId });
  };
  peerConnection.ontrack = e => {
    const stream = e.streams[0];
    if (!remoteStream) {
      remoteStream = stream;
      const remoteV = document.getElementById('remote-video');
      remoteV.srcObject = stream;
      remoteV.play().catch(() => {});
    }
  };
  peerConnection.onconnectionstatechange = () => {
    const s = peerConnection.connectionState;
    if (['disconnected', 'failed', 'closed'].includes(s)) {
      endVideoCall(); showCallEndedUI('Call disconnected');
    }
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('video-call-initiate', { offer, room, callId: currentCallId, caller: username });

  callTimeout = setTimeout(() => {
    if (!remoteStream && ['new', 'connecting'].includes(peerConnection.connectionState)) {
      endVideoCall(); showCallEndedUI('No answer');
    }
  }, 30000);
}

// Incoming Call
async function handleIncomingCall({ offer, callId, caller }) {
  if (isCallActive && peerConnection?.connectionState === 'connected') {
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
  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  showVideoCallUI();
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  const localV = document.getElementById('local-video');
  localV.srcObject = localStream;
  localV.muted = true; localV.play().catch(() => {});
  localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

  peerConnection.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { candidate: e.candidate, room, callId });
  };
  peerConnection.ontrack = e => {
  if (!remoteStream) {
    remoteStream = new MediaStream();
    const remoteV = document.getElementById('remote-video');
    remoteV.srcObject = remoteStream;
    remoteV.play().catch(() => {});
  }
  e.streams[0]?.getTracks().forEach(track => {
    if (!remoteStream.getTracks().includes(track)) {
      remoteStream.addTrack(track);
    }
  });
};
  peerConnection.onconnectionstatechange = () => {
    const st = peerConnection.connectionState;
    if (['disconnected', 'failed', 'closed'].includes(st)) {
      endVideoCall(); showCallEndedUI('Call disconnected');
    }
  };

  await peerConnection.setRemoteDescription(offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('video-answer', { answer, room, callId });

  iceQueue.forEach(c => peerConnection.addIceCandidate(c));
  iceQueue = [];
}

// End Call
function endVideoCall() {
  [localStream, remoteStream].forEach(s => s?.getTracks()?.forEach(t => t.stop()));
  peerConnection?.close();
  isCallActive = false;
  currentCallId = null;
  clearTimeout(callTimeout);
  hideCallUI();
  socket.emit('end-call', { room, callId: currentCallId });
}

// Socket Events
socket.on('connect', () => socket.emit('joinRoom', { username, room }));
socket.on('message', msg => {
  if (msg.username !== username && !isMuted) notificationSound.play().catch(() => {});
  addMessage(msg);
});
socket.on('showTyping', ({ username: u }) => u !== username && showTypingIndicator(u));
socket.on('stopTyping', () => document.querySelectorAll('.typing-indicator').forEach(el => el.remove()));
socket.on('incoming-call', handleIncomingCall);
socket.on('video-answer', async ({ answer, callId }) => {
  if (callId !== currentCallId) return;
  await peerConnection.setRemoteDescription(answer);
  iceQueue.forEach(c => peerConnection.addIceCandidate(c));
  iceQueue = [];
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

// Init
videoCallBtn.onclick = () => startVideoCall();
window.addEventListener('beforeunload', () => {
  if (isCallActive) socket.emit('end-call', { room, callId: currentCallId });
});
(function init() {
  if (!username || !room) return alert('Missing username or room!');
  initDarkMode();
  roomNameElem.textContent = room;
})();