// main.js

// Initialize Socket.IO
const socket = io({
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
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

// Audio
const notificationSound = new Audio('/sounds/notification.mp3');
const callSound         = new Audio('/sounds/call.mp3');

// State
const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true }) || {};
let replyTo       = null;
let isMuted       = localStorage.getItem('isMuted') === 'true';
let lastTyping    = 0;
const SWIPE_THRESHOLD = 60;

// WebRTC
let peerConnection, localStream, remoteStream;
let currentCallId = null, callTimeout = null, isCallActive = false;
let iceQueue = [];
let isAudioMuted = false, isVideoOff = false;
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};
const uuidv4 = ()=> 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
  const r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8);
  return v.toString(16);
});

// ─────── Reply Preview ───────
function setupReply(user, id, text) {
  replyTo = { id, username: user, text };
  replyUserElem.textContent = user;
  replyTextElem.textContent = text.length>30 
    ? text.slice(0,30) + '…' 
    : text;
  replyPreview.classList.remove('d-none');
  msgInput.focus();
}
cancelReplyBtn.addEventListener('click', e=>{
  e.stopPropagation();
  replyTo = null;
  replyPreview.classList.add('d-none');
});

// ─────── Message Rendering ───────
function addMessage(msg) {
  // remove typing indicator
  const ti = document.querySelector('.typing-indicator');
  if (ti) ti.remove();

  const div = document.createElement('div');
  const isMe = msg.username === username;
  div.id = msg.id;
  div.className = 'message ' + (isMe?'you':'other') 
    + (msg.username==='ChatApp Bot'?' system':'');

  // build inner HTML
  let html = '';
  if (msg.replyTo) {
    html += `
      <div class="message-reply">
        <span class="reply-sender">${msg.replyTo.username}</span>
        <span class="reply-text">${msg.replyTo.text}</span>
      </div>`;
  }
  html += `<div class="meta"><strong>${msg.username}</strong> 
           <span class="message-time">${msg.time}</span>
           </div>
           <div class="text">${msg.text}</div>`;
  if (isMe) {
    const seen = msg.seenBy?.length>0 
      ? msg.seenBy.map(u=>u===username?'You':u).join(', ') 
      : '';
    html += `<div class="message-status">
               <span class="seen-icon">${seen?'✓✓':'✓'}</span>
               ${seen?`<span class="seen-users">${seen}</span>`:''}
             </div>`;
  }
  div.innerHTML = html;
  // swipe-to-reply on mobile
  if (!document.body.classList.contains('dark')) {
    setupSwipe(div);
  }
  div.addEventListener('click', ()=>{
    if (window.innerWidth>768) {
      const user = div.querySelector('.meta strong')?.textContent;
      const txt  = div.querySelector('.text')?.textContent;
      if (user && txt) setupReply(user, div.id, txt);
    }
  });
  chatMessages.appendChild(div);
  setTimeout(()=> chatMessages.scrollTop = chatMessages.scrollHeight, 50);
}

function setupSwipe(el) {
  let startX=0;
  el.addEventListener('touchstart', e=> startX=e.touches[0].clientX, {passive:true});
  el.addEventListener('touchmove', e=>{
    const dx=e.touches[0].clientX-startX;
    if (dx>0&&dx<100){ e.preventDefault(); el.style.transform=`translateX(${dx}px)`; }
  }, {passive:false});
  el.addEventListener('touchend', e=>{
    const dx=e.changedTouches[0].clientX-startX;
    if (dx>SWIPE_THRESHOLD) el.click();
    el.style.transform='';
  }, {passive:true});
}

// ─────── Typing ───────
msgInput.addEventListener('input', ()=>{
  const now = Date.now();
  if (now - lastTyping > 1000) {
    socket.emit('typing', { room });
    lastTyping = now;
  }
  clearTimeout(window.stopTypTimeout);
  window.stopTypTimeout = setTimeout(()=>{
    socket.emit('stopTyping', { room });
  }, 2000);
});

// ─────── Dark Mode & Mute ───────
themeBtn.addEventListener('click', ()=>{
  const d = !document.body.classList.contains('dark');
  document.body.classList.toggle('dark', d);
  localStorage.setItem('darkMode', d);
});
muteBtn.addEventListener('click', ()=>{
  isMuted = !isMuted;
  localStorage.setItem('isMuted', isMuted);
});

// ─────── Video Call UIs ───────
function showCallingUI() {
  videoCallContainer.classList.remove('d-none');
  videoCallContainer.innerHTML = `
    <div class="calling-ui">
      <div class="calling-spinner"></div>
      <div class="calling-text">Calling…</div>
      <button id="cancel-call-btn" class="btn btn-danger">
        <i class="fas fa-phone-slash"></i> Cancel
      </button>
    </div>`;
  document.getElementById('cancel-call-btn').onclick = endVideoCall;
  callSound.loop = true;
  callSound.play().catch(()=>{});
}

function showVideoCallUI() {
  videoCallContainer.innerHTML = `
    <div class="video-container">
      <video id="remote-video" autoplay playsinline></video>
      <video id="local-video"  autoplay playsinline muted></video>
    </div>
    <div class="video-controls">
      <button id="toggle-audio-btn"><i class="fas fa-microphone"></i></button>
      <button id="end-call-btn"><i class="fas fa-phone-slash"></i></button>
      <button id="toggle-video-btn"><i class="fas fa-video"></i></button>
    </div>`;
  callSound.pause(); callSound.currentTime=0;
  clearTimeout(callTimeout);

  document.getElementById('toggle-audio-btn').onclick = toggleAudio;
  document.getElementById('toggle-video-btn').onclick = toggleVideo;
  document.getElementById('end-call-btn').onclick    = endVideoCall;
}

// ─────── Media Toggles ───────
function toggleAudio() {
  isAudioMuted = !isAudioMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isAudioMuted);
}
function toggleVideo() {
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
}

// ─────── Video Call Logic ───────
async function startVideoCall() {
  if (isCallActive) return;
  // request perms
  try {
    const test = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    test.getTracks().forEach(t=>t.stop());
  } catch {
    return alert('Allow camera/mic');
  }

  isCallActive = true;
  currentCallId = uuidv4();
  peerConnection = new RTCPeerConnection(configuration);

  // get our stream
  localStream = await navigator.mediaDevices.getUserMedia({
    video:{facingMode:'user'}, audio:{noiseSuppression:true}
  });

  // show spinner
  showCallingUI();

  // inject videos
  showVideoCallUI();
  const newLocal  = document.getElementById('local-video');
  const newRemote = document.getElementById('remote-video');
  newLocal.srcObject = localStream;

  // add tracks
  localStream.getTracks().forEach(track=>{
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = e=>{
    remoteStream = e.streams[0];
    if (remoteStream) {
      newRemote.srcObject = remoteStream;
      // no re-injection: UI is already video layout
    }
  };

  peerConnection.onicecandidate = e=>{
    if (e.candidate) {
      socket.emit('ice-candidate', {
        candidate: e.candidate, room, callId: currentCallId
      });
    }
  };

  peerConnection.onconnectionstatechange = ()=>{
    if (peerConnection.connectionState !== 'connected') {
      endVideoCall();
      alert('Call disconnected');
    }
  };

  // offer
  const offer = await peerConnection.createOffer({offerToReceiveVideo:true});
  await peerConnection.setLocalDescription(offer);
  socket.emit('video-call-initiate', {
    offer, room, callId: currentCallId, caller: username
  });

  // timeout
  callTimeout = setTimeout(()=>{
    endVideoCall();
    alert('No answer');
  }, 30000);
}

function endVideoCall() {
  [localStream, remoteStream].forEach(s=>{
    s && s.getTracks().forEach(t=>t.stop());
  });
  peerConnection?.close();
  videoCallContainer.classList.add('d-none');
  socket.emit('end-call', { room, callId: currentCallId });
  isCallActive = false;
  currentCallId = null;
}

// incoming
async function handleIncoming({ offer, callId, caller }) {
  if (isCallActive) {
    socket.emit('reject-call', { room, callId, reason:'busy' });
    return;
  }
  if (!confirm(`${caller} is calling. Accept?`)) {
    socket.emit('reject-call', { room, callId });
    return;
  }
  isCallActive = true;
  currentCallId = callId;
  peerConnection = new RTCPeerConnection(configuration);

  localStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
  showVideoCallUI();
  const newLocal  = document.getElementById('local-video');
  const newRemote = document.getElementById('remote-video');
  newLocal.srcObject = localStream;

  localStream.getTracks().forEach(track=>{
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = e=>{
    remoteStream = e.streams[0];
    newRemote.srcObject = remoteStream;
  };

  peerConnection.onicecandidate = e=>{
    if (e.candidate) {
      socket.emit('ice-candidate', { candidate:e.candidate, room, callId });
    }
  };

  await peerConnection.setRemoteDescription(offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('video-answer', { answer, room, callId });
}

// ICE queue
socket.on('ice-candidate', ({ candidate, callId })=>{
  if (callId !== currentCallId) return;
  if (!peerConnection.remoteDescription) {
    iceQueue.push(candidate);
  } else {
    peerConnection.addIceCandidate(candidate);
  }
});

// ─────── Socket Events ───────
socket.on('connect', ()=> socket.emit('joinRoom',{ username, room }));
socket.on('message', msg=>{
  if (msg.username !== username && !isMuted) notificationSound.play().catch( ()=>{} );
  addMessage(msg);
});
socket.on('showTyping', ({username:u})=>{
  const ti = document.createElement('div');
  ti.className = 'typing-indicator other';
  ti.innerHTML = `<div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
                  <span class="typing-text">${u} is typing…</span>`;
  chatMessages.appendChild(ti);
});
socket.on('stopTyping', ()=> document.querySelector('.typing-indicator')?.remove());
socket.on('incoming-call', handleIncoming);
socket.on('video-answer', async ({ answer, callId })=>{
  if (callId !== currentCallId) return;
  await peerConnection.setRemoteDescription(answer);
  iceQueue.forEach(c=>peerConnection.addIceCandidate(c));
  iceQueue = [];
});
socket.on('end-call', ()=> endVideoCall());
socket.on('reject-call', ({ reason })=>{
  endVideoCall();
  alert(reason==='busy'? 'User busy' : 'Call rejected');
});

// ─────── Form & Buttons ───────
document.getElementById('chat-form').addEventListener('submit', e=>{
  e.preventDefault();
  const txt = msgInput.value.trim();
  if (!txt) return;
  socket.emit('chatMessage', { text: txt, replyTo, room });
  msgInput.value = '';
  replyTo = null;
  replyPreview.classList.add('d-none');
});

videoCallBtn.addEventListener('click', ()=> startVideoCall());

window.addEventListener('beforeunload', ()=>{
  if (isCallActive) {
    socket.emit('end-call', { room, callId: currentCallId });
  }
});