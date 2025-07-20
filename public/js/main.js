// main.js - Complete Client-Side Implementation
window.addEventListener('DOMContentLoaded', () => {
  // State variables
  let hasJoined = false;
  let replyTo = null;
  let isMuted = localStorage.getItem('isMuted') === 'true';
  let lastTypingUpdate = 0;
  const SWIPE_THRESHOLD = 60;
  let touchStartX = 0;
  let touchEndX = 0;
  let peerConnections = {};
  let localStream = null;
  let remoteStreams = {};
  let currentCallId = null;
  let callTimeout = null;
  let isCallActive = false;
  let iceQueues = {};
  let isAudioMuted = false;
  let isVideoOff = false;
  let currentCallType = null;
  let currentFacingMode = 'user';

  // DOM elements
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

  // Audio elements
  const notificationSound = new Audio('/sounds/notification.mp3');
  const callSound = new Audio('/sounds/call.mp3');

  // Query params
  const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });

  // Socket.IO connection - Connect to HTTPS for local testing
  const socket = io('https://localhost:3000', {
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    secure: true,
    rejectUnauthorized: false // Only for local testing!
  });

  // Core functions
  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function initDarkMode() {
    const dark = localStorage.getItem('darkMode') === 'true';
    document.body.classList.toggle('dark', dark);
    chatMessages.classList.toggle('dark-bg', dark);
  }

  function addMessage(msg) {
    document.querySelectorAll('.typing-indicator').forEach(el => el.remove());
    const el = document.createElement('div');
    const isMe = msg.username === username;
    const isSys = msg.username === 'ChatApp Bot';
    el.id = isSys ? '' : msg.id;
    el.className = `message ${isMe ? 'you' : 'other'}${isSys ? ' system' : ''}`;
    
    let html = '';
    if (msg.replyTo) {
      html += `<div class="message-reply">
                <span class="reply-sender">${msg.replyTo.username}</span>
                <span class="reply-text">${msg.replyTo.text}</span>
              </div>`;
    }
    
    html += `<div class="meta">
              ${isMe ? '<span class="prompt-sign">></span>' : ''}
              <strong>${msg.username}</strong>
              <span class="message-time">${msg.time}</span>
            </div>
            <div class="text">${msg.text}</div>`;
    
    if (isMe) {
      const seen = msg.seenBy || [];
      const icon = seen.length > 1 ? '✓✓' : '✓';
      const names = seen.map(u => u === username ? 'You' : u).join(', ');
      html += `<div class="message-status">
                <span class="seen-icon">${icon}</span>
                ${names ? `<span class="seen-users">${names}</span>` : ''}
              </div>`;
    }
    
    el.innerHTML = html;
    
    if (!isSys) {
      el.onclick = () => {
        const u = el.querySelector('.meta strong').textContent;
        const t = el.querySelector('.text').textContent;
        setupReply(u, el.id, t);
      };
    }
    
    chatMessages.appendChild(el);
    setTimeout(() => {
      chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
    }, 20);
  }

  function setupReply(u, id, t) {
    replyTo = { id, username: u, text: t };
    replyUserElem.textContent = u;
    replyTextElem.textContent = t.length > 30 ? t.substr(0, 30) + '...' : t;
    replyPreview.classList.remove('d-none');
    msgInput.focus();
  }

  function showTypingIndicator(u) {
    if (!document.querySelector('.typing-indicator')) {
      const d = document.createElement('div');
      d.className = 'typing-indicator other';
      d.innerHTML = `
        <div class="dots">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
        <span class="typing-text">${u} is typing...</span>
      `;
      chatMessages.appendChild(d);
      chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
    }
  }

  // Video call functions
  async function addLocalTracks(pc, stream) {
    for (const t of stream.getTracks()) pc.addTrack(t, stream);
  }

  function attachRemoteStream(userId, stream) {
    remoteStreams[userId] = stream;
    
    if (currentCallType === 'video') {
      setTimeout(() => {
        addVideoElement('remote', userId, stream);
      }, 100);
    } else {
      addAudioElement(userId);
    }
  }

  async function establishPeerConnection(userId, isInitiator = false) {
    if (!isCallActive || peerConnections[userId]) return;
    
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peerConnections[userId] = pc;

    pc.oniceconnectionstatechange = () => {
      if (['disconnected', 'failed'].includes(pc.iceConnectionState)) {
        removePeerConnection(userId);
      }
    };

    pc.ontrack = e => attachRemoteStream(userId, e.streams[0] || new MediaStream([e.track]));
    pc.onaddstream = e => attachRemoteStream(userId, e.stream);

    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        socket.emit('offer', {
          offer: pc.localDescription,
          room,
          callId: currentCallId,
          targetUser: userId
        });
      } catch (err) { console.error(err); }
    };

    if (localStream) {
      if ('addStream' in pc) pc.addStream(localStream);
      else await addLocalTracks(pc, localStream);
    }

    pc.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('ice-candidate', {
          candidate: e.candidate,
          room,
          callId: currentCallId,
          targetUser: userId
        });
      }
    };

    const queue = (iceQueues[currentCallId] || {})[userId] || [];
    for (const c of queue) await pc.addIceCandidate(c).catch(console.error);
    if (iceQueues[currentCallId]) iceQueues[currentCallId][userId] = [];
  }

  function addVideoElement(type, userId, stream, isLocal = false) {
    const g = document.getElementById('video-grid');
    if (!g) return;

    let ex = document.getElementById(`${type}-container-${userId}`);
    if (ex) ex.remove();

    const c = document.createElement('div');
    c.className = `video-container ${isLocal ? 'local-video-container' : ''}`;
    c.id = `${type}-container-${userId}`;

    const v = document.createElement('video');
    v.id = `${type}-video-${userId}`;
    v.autoplay = true;
    v.playsInline = true;
    v.muted = isLocal;
    if (isLocal && currentCallType === 'video') v.style.transform = 'scaleX(-1)';

    const l = document.createElement('div');
    l.className = 'video-user-label';
    l.textContent = userId === username ? 'You' : userId;

    c.appendChild(v);
    c.appendChild(l);
    g.appendChild(c);

    v.srcObject = stream;

    const playPromise = v.play();
    if (playPromise !== undefined) {
      playPromise.catch(err => {
        const playBtn = document.createElement('button');
        playBtn.className = 'video-play-btn';
        playBtn.innerHTML = '<i class="fas fa-play"></i>';
        playBtn.onclick = () => {
          v.play().then(() => playBtn.remove()).catch(console.error);
        };
        c.appendChild(playBtn);
      });
    }
  }

  function addAudioElement(userId) {
    const g = document.getElementById('video-grid');
    if (!g) return;
    
    const c = document.createElement('div');
    c.className = 'audio-container';
    c.id = `audio-container-${userId}`;
    
    const l = document.createElement('div');
    l.className = 'video-user-label';
    l.textContent = userId === username ? 'You' : userId;
    
    const i = document.createElement('div');
    i.className = 'audio-icon';
    i.innerHTML = '<i class="fas fa-microphone"></i>';
    
    c.appendChild(i);
    c.appendChild(l);
    g.appendChild(c);
  }

  // Call UI functions
  function showCallingUI(t) {
    videoCallContainer.innerHTML = `
      <div class="calling-ui">
        <div class="calling-spinner"></div>
        <div class="calling-text">Calling ${t === 'audio' ? '(Audio)' : '(Video)'}...</div>
        <button id="cancel-call-btn" class="btn btn-danger">
          <i class="fas fa-phone-slash"></i> Cancel
        </button>
      </div>
    `;
    videoCallContainer.classList.remove('d-none');
    document.getElementById('cancel-call-btn').onclick = endCall;
    
    callSound.loop = true;
    callSound.play().catch(() => {
      const soundBtn = document.createElement('button');
      soundBtn.className = 'sound-permission-btn';
      soundBtn.innerHTML = '<i class="fas fa-volume-up"></i> Click to enable call sounds';
      soundBtn.onclick = () => {
        callSound.play().then(() => soundBtn.remove()).catch(console.error);
      };
      videoCallContainer.querySelector('.calling-ui').appendChild(soundBtn);
    });
  }

  function showCallUI(t) {
    callSound.pause();
    clearTimeout(callTimeout);
    
    let controls = `
      <button id="toggle-audio-btn" class="control-btn audio-btn">
        <i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>
      </button>
      <button id="end-call-btn" class="control-btn end-btn">
        <i class="fas fa-phone-slash"></i>
      </button>
    `;
    
    if (t === 'video') {
      controls += `
        <button id="toggle-video-btn" class="control-btn video-btn">
          <i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>
        </button>
        <button id="flip-camera-btn" class="control-btn flip-btn">
          <i class="fas fa-camera-retro"></i>
        </button>
      `;
    }
    
    videoCallContainer.innerHTML = `
      <div class="video-call-active">
        <div id="video-grid" class="video-grid"></div>
        <div class="video-controls">${controls}</div>
      </div>
    `;
    
    videoCallContainer.classList.remove('d-none');
    document.getElementById('toggle-audio-btn').onclick = toggleAudio;
    document.getElementById('end-call-btn').onclick = endCall;
    
    if (t === 'video') {
      document.getElementById('toggle-video-btn').onclick = toggleVideo;
      document.getElementById('flip-camera-btn').onclick = flipCamera;
      addVideoElement('local', username, localStream, true);
    }
  }

  function hideCallUI() {
    videoCallContainer.classList.add('d-none');
    callSound.pause();
    clearTimeout(callTimeout);
  }

  function showCallEndedUI(m) {
    const d = document.createElement('div');
    d.className = 'call-ended-alert';
    d.innerHTML = `
      <div class="alert-content">
        <p>${m}</p>
        <button id="close-alert-btn" class="btn btn-primary">OK</button>
      </div>
    `;
    document.body.appendChild(d);
    document.getElementById('close-alert-btn').onclick = () => d.remove();
  }

  // Call management
  async function startCall(t) {
    if (isCallActive) return;

    try {
      const testStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: t === 'video' ? { facingMode: 'user' } : false
      });
      testStream.getTracks().forEach(track => track.stop());
    } catch (err) {
      return alert(`Please allow ${t === 'video' ? 'camera and microphone' : 'microphone'} access.`);
    }

    isCallActive = true;
    currentCallType = t;
    currentCallId = uuidv4();
    iceQueues[currentCallId] = {};

    showCallingUI(t);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: t === 'video' ? { facingMode: 'user' } : false
      });

      showCallUI(t);
      socket.emit('call-initiate', {
        room,
        callId: currentCallId,
        callType: t,
        caller: username
      });

      callTimeout = setTimeout(() => {
        if (!Object.keys(peerConnections).length) {
          endCall();
          showCallEndedUI('No one answered');
        }
      }, 45000);
    } catch (err) {
      console.error('Call start failed:', err);
      endCall();
      showCallEndedUI('Call failed to start');
    }
  }

  async function handleIncomingCall({ callType, callId, caller }) {
    if (isCallActive) {
      socket.emit('reject-call', { room, callId, reason: 'busy' });
      return;
    }
    
    const ok = confirm(`${caller} is calling (${callType}). Accept?`);
    if (!ok) {
      socket.emit('reject-call', { room, callId });
      return;
    }
    
    isCallActive = true;
    currentCallType = callType;
    currentCallId = callId;
    iceQueues[callId] = {};
    
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video' ? { facingMode: 'user' } : false
      });
      
      showCallUI(callType);
      socket.emit('accept-call', { room, callId });
      socket.emit('get-call-participants', { room, callId });
    } catch (e) {
      console.error(e);
      endCall();
    }
  }

  function endCall() {
    Object.keys(peerConnections).forEach(removePeerConnection);
    
    if (localStream) {
      localStream.getTracks().forEach(x => x.stop());
      localStream = null;
    }
    
    isCallActive = false;
    currentCallId = null;
    currentCallType = null;
    clearTimeout(callTimeout);
    hideCallUI();
    
    if (currentCallId) {
      socket.emit('end-call', { room, callId: currentCallId });
    }
  }

  function removePeerConnection(uid) {
    if (peerConnections[uid]) {
      peerConnections[uid].close();
      delete peerConnections[uid];
    }
    
    const vc = document.getElementById(`remote-container-${uid}`);
    if (vc) vc.remove();
    
    const ac = document.getElementById(`audio-container-${uid}`);
    if (ac) ac.remove();
    
    delete remoteStreams[uid];
  }

  // Media control functions
  function updateMediaButtons() {
    const a = document.getElementById('toggle-audio-btn');
    const v = document.getElementById('toggle-video-btn');
    
    if (a) {
      a.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
    }
    
    if (v) {
      v.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
    }
  }

  async function toggleAudio() {
    isAudioMuted = !isAudioMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isAudioMuted);
    updateMediaButtons();
    socket.emit('mute-state', {
      room,
      callId: currentCallId,
      isAudioMuted,
      userId: username
    });
  }

  async function toggleVideo() {
    isVideoOff = !isVideoOff;
    localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
    updateMediaButtons();
    socket.emit('video-state', {
      room,
      callId: currentCallId,
      isVideoOff,
      userId: username
    });
  }

  async function flipCamera() {
    if (!localStream || currentCallType !== 'video') return;
    
    localStream.getVideoTracks().forEach(t => t.stop());
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    
    try {
      const ns = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: currentFacingMode }
      });
      
      localStream.getTracks().forEach(t => localStream.removeTrack(t));
      ns.getTracks().forEach(t => localStream.addTrack(t));
      
      Object.values(peerConnections).forEach(pc => {
        const s = pc.getSenders().find(x => x.track.kind === 'video');
        if (s) s.replaceTrack(localStream.getVideoTracks()[0]);
      });
      
      const lv = document.getElementById(`local-video-${username}`);
      if (lv) lv.srcObject = localStream;
    } catch (e) {
      console.error(e);
    }
  }

  // Event listeners
  cancelReplyBtn.onclick = e => {
    e.stopPropagation();
    replyTo = null;
    replyPreview.classList.add('d-none');
  };

  chatMessages.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
  }, false);

  chatMessages.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    const diffX = touchStartX - touchEndX;
    
    if (Math.abs(diffX) > SWIPE_THRESHOLD) {
      const messageElement = document.elementFromPoint(
        e.changedTouches[0].clientX,
        e.changedTouches[0].clientY
      );
      
      if (messageElement && messageElement.classList.contains('message')) {
        const u = messageElement.querySelector('.meta strong').textContent;
        const t = messageElement.querySelector('.text').textContent;
        const id = messageElement.id;
        setupReply(u, id, t);
      }
    }
  }, false);

  document.getElementById('chat-form').onsubmit = e => {
    e.preventDefault();
    const txt = msgInput.value.trim();
    if (!txt) return;
    
    socket.emit('chatMessage', { text: txt, replyTo, room });
    msgInput.value = '';
    replyTo = null;
    replyPreview.classList.add('d-none');
  };

  themeBtn.onclick = () => {
    const dark = !document.body.classList.toggle('dark');
    localStorage.setItem('darkMode', dark);
    chatMessages.classList.toggle('dark-bg', dark);
  };

  muteBtn.onclick = () => {
    isMuted = !isMuted;
    localStorage.setItem('isMuted', isMuted);
    muteBtn.innerHTML = isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';
  };

  videoCallBtn.onclick = () => startCall('video');
  audioCallBtn.onclick = () => startCall('audio');

  window.addEventListener('beforeunload', () => {
    if (isCallActive) {
      socket.emit('end-call', { room, callId: currentCallId });
    }
  });

  // Socket.IO handlers
  socket.on('connect', () => {
    if (!hasJoined) {
      socket.emit('joinRoom', { username, room });
      hasJoined = true;
    }
  });

  socket.on('message', msg => {
    if (msg.username !== username && !isMuted) {
      notificationSound.play().catch(e => console.log('Audio play failed:', e));
    }
    addMessage(msg);
  });

  socket.on('typing', ({ username: u }) => {
    if (u !== username) showTypingIndicator(u);
  });

  socket.on('stopTyping', () => {
    document.querySelectorAll('.typing-indicator').forEach(el => el.remove());
  });

  socket.on('incoming-call', handleIncomingCall);

  socket.on('offer', async ({ offer, userId, callId }) => {
    if (callId !== currentCallId || !isCallActive) return;
    
    await establishPeerConnection(userId);
    const pc = peerConnections[userId];
    await pc.setRemoteDescription(offer);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    
    socket.emit('answer', {
      answer: ans,
      room,
      callId,
      targetUser: userId
    });
  });

  socket.on('answer', ({ answer, userId, callId }) => {
    if (callId !== currentCallId) return;
    peerConnections[userId]?.setRemoteDescription(answer);
  });

  socket.on('ice-candidate', ({ candidate, userId, callId }) => {
    if (!peerConnections[userId]) {
      iceQueues[callId] = iceQueues[callId] || {};
      iceQueues[callId][userId] = iceQueues[callId][userId] || [];
      iceQueues[callId][userId].push(candidate);
    } else {
      peerConnections[userId].addIceCandidate(candidate).catch(console.error);
    }
  });

  socket.on('call-participants', ({ participants, callId }) => {
    if (callId !== currentCallId) return;
    
    participants.forEach(uid => {
      if (uid !== username && !peerConnections[uid]) {
        const init = participants.indexOf(username) < participants.indexOf(uid);
        establishPeerConnection(uid, init);
      }
    });
  });

  socket.on('accept-call', async ({ userId, callId }) => {
    if (callId !== currentCallId || !isCallActive) return;
    await establishPeerConnection(userId, true);
  });

  socket.on('end-call', () => {
    endCall();
    showCallEndedUI('Call ended');
  });

  socket.on('reject-call', ({ reason }) => {
    endCall();
    showCallEndedUI(reason === 'busy' ? 'User busy' : 'Call rejected');
  });

  socket.on('user-left-call', ({ userId }) => {
    removePeerConnection(userId);
  });

  socket.on('mute-state', ({ userId, isAudioMuted }) => {
    console.log(`User ${userId} ${isAudioMuted ? 'muted' : 'unmuted'} audio`);
  });

  socket.on('video-state', ({ userId, isVideoOff }) => {
    console.log(`User ${userId} ${isVideoOff ? 'disabled' : 'enabled'} video`);
  });

  // Initialization
  function init() {
    if (!username || !room) {
      alert('Missing username or room!');
      return;
    }

    initDarkMode();
    roomNameElem.textContent = room;
    muteBtn.innerHTML = isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';

    // Add styles dynamically
    const style = document.createElement('style');
    style.textContent = `
      .video-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 10px;
        padding: 10px;
        width: 100%;
        height: calc(100% - 60px);
        overflow-y: auto;
      }
      .video-container {
        position: relative;
        background: #000;
        border-radius: 8px;
        overflow: hidden;
        aspect-ratio: 4/3;
      }
      .video-container video {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .video-user-label {
        position: absolute;
        bottom: 5px;
        left: 5px;
        color: #fff;
        background: rgba(0,0,0,0.5);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 12px;
      }
      .local-video-container {
        order: -1;
      }
      .audio-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #f0f0f0;
        border-radius: 8px;
        padding: 20px;
      }
      .audio-icon {
        font-size: 24px;
        margin-bottom: 10px;
      }
      .typing-indicator {
        display: flex;
        align-items: center;
        padding: 8px 12px;
        color: #666;
        font-style: italic;
      }
      .dots {
        display: flex;
        margin-right: 8px;
      }
      .dot {
        width: 6px;
        height: 6px;
        background: #666;
        border-radius: 50%;
        margin: 0 2px;
        animation: bounce 1.4s infinite ease-in-out;
      }
      .dot:nth-child(1) { animation-delay: -0.32s; }
      .dot:nth-child(2) { animation-delay: -0.16s; }
      @keyframes bounce {
        0%, 80%, 100% { transform: translateY(0); }
        40% { transform: translateY(-5px); }
      }
      .video-play-btn, .sound-permission-btn {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0,0,0,0.7);
        color: white;
        border: none;
        border-radius: 4px;
        padding: 8px 12px;
        font-size: 14px;
        cursor: pointer;
        z-index: 10;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .sound-permission-btn {
        position: relative;
        top: auto;
        left: auto;
        transform: none;
        margin-top: 10px;
      }
    `;
    document.head.appendChild(style);
  }

  init();
});