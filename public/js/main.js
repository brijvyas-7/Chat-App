// main.js

const socket = io({ reconnection: true, reconnectionAttempts: 5 });

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

const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });

let peerConnection, localStream, remoteStream;
let isCallActive = false;
let currentCallId = null;
let isAudioMuted = false;
let isVideoOff = false;
let iceQueue = [];
let callTimeout;

const ICE_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ---------- Dark Mode ----------
function initDarkMode() {
  const isDark = localStorage.getItem('darkMode') === 'true';
  document.body.classList.toggle('dark', isDark);
  chatMessages.classList.toggle('dark-bg', isDark);
}
themeBtn.onclick = () => {
  const isDark = !document.body.classList.toggle('dark');
  chatMessages.classList.toggle('dark-bg', isDark);
  localStorage.setItem('darkMode', isDark);
};

// ---------- Mute Toggle ----------
let isMuted = localStorage.getItem('isMuted') === 'true';
muteBtn.innerHTML = isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';
muteBtn.onclick = () => {
  isMuted = !isMuted;
  muteBtn.innerHTML = isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';
  localStorage.setItem('isMuted', isMuted);
};

// ---------- Reply ----------
let replyTo = null;
cancelReplyBtn.onclick = () => {
  replyTo = null;
  replyPreview.classList.add('d-none');
};
function setupReply(user, id, text) {
  replyTo = { id, username: user, text };
  replyUserElem.textContent = user;
  replyTextElem.textContent = text.length > 30 ? text.slice(0, 30) + '…' : text;
  replyPreview.classList.remove('d-none');
}

// ---------- Swipe Reply ----------
function setupSwipeHandler(el) {
  let startX = 0;
  el.addEventListener('touchstart', e => startX = e.touches[0].clientX);
  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    if (dx > 60) el.click();
  });
}

// ---------- Messages ----------
function addMessage(msg) {
  document.querySelectorAll('.typing-indicator').forEach(el => el.remove());
  const el = document.createElement('div');
  const isMe = msg.username === username;
  el.id = msg.id;
  el.className = `message ${isMe ? 'you' : 'other'}`;

  let html = '';
  if (msg.replyTo) {
    html += `<div class="message-reply"><span class="reply-sender">${msg.replyTo.username}</span>
             <span class="reply-text">${msg.replyTo.text}</span></div>`;
  }
  html += `<div class="meta"><strong>${msg.username}</strong>
           <span class="message-time">${msg.time}</span></div>
           <div class="text">${msg.text}</div>`;

  if (isMe) {
    const seen = msg.seenBy || [];
    const seenIcon = seen.length > 1 ? '✓✓' : '✓';
    html += `<div class="message-status"><span class="seen-icon">${seenIcon}</span></div>`;
  }

  el.innerHTML = html;
  if (!msg.username.startsWith('ChatApp Bot')) {
    el.onclick = () => {
      const text = el.querySelector('.text').textContent;
      const user = el.querySelector('.meta strong').textContent;
      setupReply(user, el.id, text);
    };
    setupSwipeHandler(el);
  }

  chatMessages.appendChild(el);
  setTimeout(() => chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' }), 10);
}

// ---------- Typing ----------
let lastTyping = 0;
msgInput.oninput = () => {
  const now = Date.now();
  if (now - lastTyping > 1000) {
    socket.emit('typing', { room });
    lastTyping = now;
  }
  clearTimeout(window._stopTyping);
  window._stopTyping = setTimeout(() => socket.emit('stopTyping', { room }), 1500);
};
function showTypingIndicator(user) {
  if (!document.querySelector('.typing-indicator')) {
    const d = document.createElement('div');
    d.className = 'typing-indicator other';
    d.innerHTML = `<div class="dots"><span></span><span></span><span></span></div>
                   <span>${user} is typing…</span>`;
    chatMessages.appendChild(d);
    chatMessages.scrollTo({ top: chatMessages.scrollHeight });
  }
}

// ---------- Video UI ----------
function showVideoUI() {
  callSound.pause();
  clearTimeout(callTimeout);
  videoCallContainer.innerHTML = `
    <div class="video-container">
      <video id="remote-video" autoplay playsinline></video>
      <video id="local-video" autoplay playsinline muted></video>
    </div>
    <div class="video-controls">
      <button id="toggle-audio-btn"><i class="fas fa-microphone"></i></button>
      <button id="end-call-btn"><i class="fas fa-phone-slash"></i></button>
      <button id="toggle-video-btn"><i class="fas fa-video"></i></button>
    </div>`;
  document.getElementById('toggle-audio-btn').onclick = toggleAudio;
  document.getElementById('toggle-video-btn').onclick = toggleVideo;
  document.getElementById('end-call-btn').onclick = endVideoCall;
  videoCallContainer.classList.remove('d-none');
}
function hideVideoUI() {
  videoCallContainer.classList.add('d-none');
}

// ---------- Call Media Buttons ----------
function toggleAudio() {
  isAudioMuted = !isAudioMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isAudioMuted);
}
function toggleVideo() {
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
}

// ---------- Video Call ----------
async function startVideoCall() {
  if (isCallActive) return;
  isCallActive = true;
  currentCallId = crypto.randomUUID();
  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { candidate: e.candidate, room, callId: currentCallId });
  };

  peerConnection.ontrack = e => {
    remoteStream = e.streams[0];
    document.getElementById('remote-video').srcObject = remoteStream;
  };

  showVideoUI();
  document.getElementById('local-video').srcObject = localStream;

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('video-call-initiate', { offer, room, callId: currentCallId, caller: username });

  callTimeout = setTimeout(() => {
    if (!remoteStream) {
      endVideoCall();
      alert('No answer');
    }
  }, 30000);
}

async function handleIncomingCall({ offer, callId, caller }) {
  const accept = confirm(`${caller} is calling. Accept?`);
  if (!accept) return socket.emit('reject-call', { room, callId });

  isCallActive = true;
  currentCallId = callId;
  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  peerConnection.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { candidate: e.candidate, room, callId });
  };

  peerConnection.ontrack = e => {
    remoteStream = e.streams[0];
    document.getElementById('remote-video').srcObject = remoteStream;
  };

  showVideoUI();
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  document.getElementById('local-video').srcObject = localStream;

  await peerConnection.setRemoteDescription(offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('video-answer', { answer, room, callId });

  iceQueue.forEach(c => peerConnection.addIceCandidate(c));
  iceQueue = [];
}

function endVideoCall() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (remoteStream) remoteStream.getTracks().forEach(t => t.stop());
  peerConnection?.close();
  isCallActive = false;
  currentCallId = null;
  hideVideoUI();
  socket.emit('end-call', { room, callId: currentCallId });
}

// ---------- Socket Events ----------
socket.on('connect', () => socket.emit('joinRoom', { username, room }));
socket.on('message', msg => {
  if (msg.username !== username && !isMuted) notificationSound.play().catch(() => {});
  addMessage(msg);
});
socket.on('showTyping', ({ username: u }) => u !== username && showTypingIndicator(u));
socket.on('stopTyping', () => document.querySelectorAll('.typing-indicator').forEach(el => el.remove());
socket.on('incoming-call', handleIncomingCall);
socket.on('video-answer', async ({ answer, callId }) => {
  if (callId !== currentCallId) return;
  await peerConnection.setRemoteDescription(answer);
});
socket.on('ice-candidate', ({ candidate, callId }) => {
  if (callId !== currentCallId) return iceQueue.push(candidate);
  peerConnection.addIceCandidate(candidate).catch(console.error);
});
socket.on('end-call', () => endVideoCall());
socket.on('reject-call', () => {
  endVideoCall();
  alert('Call rejected or busy');
});

// ---------- Form & Init ----------
document.getElementById('chat-form').onsubmit = e => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('chatMessage', { text, replyTo, room });
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
};

videoCallBtn.onclick = () => startVideoCall();

(function init() {
  if (!username || !room) return alert('Missing info!');
  initDarkMode();
  roomNameElem.textContent = room;
})();