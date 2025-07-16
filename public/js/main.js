// =============================
// 1. Initial Setup & Imports
// =============================
const socket = io({ reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });
const {
  msgInput, chatMessages, replyPreview, replyUserElem, replyTextElem,
  cancelReplyBtn, themeBtn, muteBtn, roomNameElem, videoCallBtn, videoCallContainer
} = {
  msgInput: document.getElementById('msg'),
  chatMessages: document.getElementById('chat-messages'),
  replyPreview: document.getElementById('reply-preview'),
  replyUserElem: document.getElementById('reply-user'),
  replyTextElem: document.getElementById('reply-text'),
  cancelReplyBtn: document.getElementById('cancel-reply'),
  themeBtn: document.getElementById('theme-toggle'),
  muteBtn: document.getElementById('mute-toggle'),
  roomNameElem: document.getElementById('room-name'),
  videoCallBtn: document.getElementById('video-call-btn'),
  videoCallContainer: document.getElementById('video-call-container')
};
const notificationSound = new Audio('/sounds/notification.mp3');
const callSound = new Audio('/sounds/call.mp3');
const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true }) || {};

let replyTo = null;
let isMuted = localStorage.getItem('isMuted') === 'true';
let lastTypingUpdate = 0;
const SWIPE_THRESHOLD = 60;
// ============ Reply Setup ============
function setupReply(user, msgID, text) {
  replyTo = { id: msgID, username: user, text };
  replyUserElem.textContent   = user;
  replyTextElem.textContent   = text.length > 30 ? text.slice(0,30) + '…' : text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();
}
cancelReplyBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  replyTo = null;
  replyPreview.classList.add('d-none');
});

// ============ Message Render + Swipe ============
function addMessage(msg) {
  const old = document.querySelector('.typing-indicator');
  if (old) old.remove();

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
    <div class="text">${msg.text}</div>`;
  if (isMe) {
    const seenNames = msg.seenBy?.length > 0
      ? msg.seenBy.map(u => u === username ? 'You' : u).join(', ') : '';
    html += `<div class="message-status">
      <span class="seen-icon">${seenNames? '✓✓':'✓'}</span>
      ${seenNames? `<span class="seen-users">${seenNames}</span>` : ''}
    </div>`;
  }
  div.innerHTML = html;

  if (!document.body.classList.contains('dark')) setupSwipeHandler(div);
  div.addEventListener('click', () => {
    if (window.innerWidth > 768 && !isSystem) {
      const u = div.querySelector('.meta strong')?.textContent;
      const t = div.querySelector('.text')?.textContent;
      if (u && t) setupReply(u, div.id, t);
    }
  });
  chatMessages.appendChild(div);
  chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
}

function setupSwipeHandler(el) {
  let startX = 0;
  el.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - startX;
    if (dx > 0 && dx < 100) { e.preventDefault(); el.style.transform = `translateX(${dx}px)`; }
  }, { passive: false });
  el.addEventListener('touchend', e => {
    if (e.changedTouches[0].clientX - startX > SWIPE_THRESHOLD) el.click();
    el.style.transform = '';
  }, { passive: true });
}

// ============ Typing Indicator ============
msgInput.addEventListener('input', () => {
  const now = Date.now();
  if (now - lastTypingUpdate > 1000) {
    socket.emit('typing', { room });
    lastTypingUpdate = now;
  }
  clearTimeout(window._st);
  window._st = setTimeout(() => socket.emit('stopTyping', { room }), 2000);
});
function showTypingIndicator(user) {
  document.querySelector('.typing-indicator')?.remove();
  const div = document.createElement('div');
  div.className = 'typing-indicator other';
  div.innerHTML = `
    <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    <span class="typing-text">${user} is typing…</span>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
}

// ============ Seen Receipts ============
function markMessagesAsSeen() {
  const ids = Array.from(chatMessages.querySelectorAll('.message.you'))
    .map(e => e.id).filter(Boolean);
  if (ids.length) socket.emit('markAsSeen', { messageIds: ids, room });
}

// ============ Dark Mode & Mute ============
themeBtn.addEventListener('click', () => {
  const dark = !document.body.classList.toggle('dark');
  localStorage.setItem('darkMode', dark);
});
muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStorage.setItem('isMuted', isMuted);
});
// ===== WebRTC state
let peerConn, localStream, remoteStream;
let currentCallId = null, callTO = null, isCallActive = false, iceQueue = [], isAudioMuted = false, isVideoOff = false;
const ICE = { iceServers: [{urls:'stun:stun.l.google.com:19302'}] };

// ===== Call UI
function showCallingUI() {
  videoCallContainer.innerHTML = `
    <div class="calling-ui">
      <div class="calling-spinner"></div>
      <div class="calling-text">Calling…</div>
      <button id="cancel-call-btn" class="btn btn-danger">
        <i class="fas fa-phone-slash"></i>
      </button>
    </div>`;
  centerOverlay(videoCallContainer);
  callSound.loop = true; callSound.play().catch(()=>{});
  document.getElementById('cancel-call-btn').onclick = endCall;
}
function showVideoUI() {
  clearTimeout(callTO);
  callSound.pause(); callSound.currentTime = 0;
  videoCallContainer.innerHTML = `
    <div class="video-container">
      <video id="remote-video" autoplay playsinline class="remote-video"></video>
      <video id="local-video" autoplay playsinline muted class="local-video"></video>
    </div>
    <div class="video-controls">
      <button id="toggle-audio" class="control-btn"><i class="fas fa-microphone"></i></button>
      <button id="end-call" class="control-btn"><i class="fas fa-phone-slash"></i></button>
      <button id="toggle-video" class="control-btn"><i class="fas fa-video"></i></button>
    </div>`;
  centerOverlay(videoCallContainer);
  document.getElementById('toggle-audio').onclick = toggleAudio;
  document.getElementById('toggle-video').onclick = toggleVideo;
  document.getElementById('end-call').onclick = endCall;
}

// ===== center overlay function
function centerOverlay(el) {
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
}

// ===== Video controls
function toggleAudio() {
  isAudioMuted = !isAudioMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isAudioMuted);
}
function toggleVideo() {
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
}

// ===== Call logic
async function startCall() {
  if (isCallActive) return;
  try {
    await navigator.mediaDevices.getUserMedia({ video:true, audio:true }).then(s=>s.getTracks().forEach(t=>t.stop()));
  } catch(e) { return alert('Allow camera+mic!'); }
  isCallActive = true; currentCallId = uuidv4();
  peerConn = new RTCPeerConnection(ICE);
  localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
  showCallingUI(); showVideoUI();
  const localV = document.getElementById('local-video');
  localV.srcObject = localStream;
  await localV.play().catch(()=>{});
  localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));
  peerConn.onicecandidate = e => { if (e.candidate) socket.emit('ice-candidate',{candidate:e.candidate,room,callId:currentCallId}); };
  peerConn.ontrack = e => {
    remoteStream = e.streams[0];
    const rv = document.getElementById('remote-video');
    rv.srcObject = remoteStream;
    rv.play().catch(()=>{});
  };
  peerConn.onconnectionstatechange = () => {
    if (peerConn.connectionState === 'connected') { clearTimeout(callTO); } 
    else if (['disconnected','failed'].includes(peerConn.connectionState)) {
      endCall(); callEndedModal('Call disconnected');
    }
  };
  const offer = await peerConn.createOffer();
  await peerConn.setLocalDescription(offer);
  socket.emit('video-call-initiate',{offer,room,callId:currentCallId,caller:username});
  callTO = setTimeout(()=>{ if(!remoteStream){ endCall(); callEndedModal('No answer'); } },30000);
}

async function handleIncoming({offer,callId,caller}) {
  if (isCallActive && peerConn?.connectionState === 'connected') {
    return socket.emit('reject-call',{room,callId,reason:'busy'});
  }
  if(!confirm(`${caller} is calling. Accept?`)) {
    return socket.emit('reject-call',{room,callId});
  }
  isCallActive = true; currentCallId = callId;
  peerConn = new RTCPeerConnection(ICE);
  localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
  showVideoUI();
  const localV = document.getElementById('local-video');
  localV.srcObject = localStream; localV.play().catch(()=>{});
  localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));
  peerConn.onicecandidate = e => { if(e.candidate) socket.emit('ice-candidate',{candidate:e.candidate,room,callId}); };
  peerConn.ontrack = e => {
    remoteStream = e.streams[0];
    const rv = document.getElementById('remote-video');
    rv.srcObject = remoteStream; rv.play().catch(()=>{});
  };
  peerConn.onconnectionstatechange = () => {
    if (peerConn.connectionState !== 'connected') {
      endCall(); callEndedModal('Call disconnected');
    }
  };
  await peerConn.setRemoteDescription(offer);
  const ans = await peerConn.createAnswer();
  await peerConn.setLocalDescription(ans);
  socket.emit('video-answer',{answer:ans,room,callId});
}

// ===== End + alert
function endCall() {
  if (localStream) localStream.getTracks().forEach(t=>t.stop());
  if (remoteStream) remoteStream.getTracks().forEach(t=>t.stop());
  peerConn?.close(); peerConn=null;
  socket.emit('end-call',{room,callId:currentCallId});
  isCallActive=false; clearTimeout(callTO); iceQueue=[];
  videoCallContainer.style.display='none';
}
function callEndedModal(msg) {
  const al = document.createElement('div');
  al.className = 'call-ended-alert';
  al.innerHTML = `<div class="alert-content"><p>${msg}</p><button id="close-alert-btn">OK</button></div>`;
  document.body.appendChild(al);
  al.style.display='flex'; al.style.alignItems='center'; al.style.justifyContent='center';
  document.getElementById('close-alert-btn').onclick = ()=>al.remove();
}

// ===== Socket Events
socket.on('connect', () => socket.emit('joinRoom',{username,room}));
socket.on('message', msg => {
  if (msg.username !== username && !isMuted) notificationSound.play().catch(()=>{});
  addMessage(msg);
  markMessagesAsSeen();
});
socket.on('showTyping', ({username:u}) => u!== username && showTypingIndicator(u));
socket.on('stopTyping', () => document.querySelector('.typing-indicator')?.remove());
socket.on('messagesSeen', arr => {
  arr.forEach(u=>{
    const m = document.getElementById(u.messageId);
    if (!m) return;
    const status = m.querySelector('.message-status');
    const seenTxt = u.seenBy.map(x=> x===username?'You':x).join(', ');
    status.innerHTML = `<span class="seen-icon">${u.seenBy.length>1?'✓✓':'✓'}</span>${seenTxt?`<span class="seen-users">${seenTxt}</span>`:''}`;
  });
});
socket.on('incoming-call', handleIncoming);
socket.on('video-answer', async ({answer,callId}) => {
  if (callId === currentCallId) {
    await peerConn.setRemoteDescription(answer);
    iceQueue.forEach(c=>peerConn.addIceCandidate(c));
    iceQueue=[];
  }
});
socket.on('ice-candidate', ({candidate,callId}) => {
  if (callId !== currentCallId) return iceQueue.push(candidate);
  peerConn.addIceCandidate(candidate).catch(console.error);
});
socket.on('reject-call', ({reason}) => {
  endCall(); callEndedModal(reason==='busy'?'User is busy':'Call rejected');
});
socket.on('end-call', () => { endCall(); callEndedModal('Call ended'); });

// ===== Event Listeners + Init
document.getElementById('chat-form').onsubmit = e => {
  e.preventDefault();
  const txt = msgInput.value.trim();
  if (!txt) return;
  socket.emit('chatMessage', {text:txt,replyTo,room});
  msgInput.value=''; replyTo=null; replyPreview.classList.add('d-none');
};
videoCallBtn.onclick = startCall;
window.onbeforeunload = () => {
  if (isCallActive) socket.emit('end-call',{room,callId:currentCallId});
};
if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
  window.addEventListener('resize', () => document.querySelector('header').style.position = 'sticky');
}
function init() {
  if (!username || !room) return alert('Missing username or room');
  document.body.classList.toggle('dark', localStorage.getItem('darkMode')==='true');
  isMuted = localStorage.getItem('isMuted')==='true';
  roomNameElem.textContent = room;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
init();
