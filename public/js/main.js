// ======================
// main.js (complete ~820 lines)
// ======================

window.addEventListener('DOMContentLoaded', () => {
  // ======================
  // SOCKET.IO CONNECTION
  // ======================
  const socket = io('https://chat-app-a3m9.onrender.com', {
    transports: ['websocket'],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
  });

  // ======================
  // DOM ELEMENTS
  // ======================
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
  const audioCallBtn       = document.getElementById('audio-call-btn');
  const videoCallContainer = document.getElementById('video-call-container');

  // ======================
  // AUDIO ELEMENTS
  // ======================
  const notificationSound = new Audio('/sounds/notification.mp3');
  const callSound         = new Audio('/sounds/call.mp3');

  // ======================
  // QUERY PARAMS
  // ======================
  const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });

  // ======================
  // CHAT STATE
  // ======================
  let replyTo           = null;
  let isMuted           = localStorage.getItem('isMuted') === 'true';
  let lastTypingUpdate  = 0;
  const SWIPE_THRESHOLD = 60;

  // ======================
  // WEBRTC STATE
  // ======================
  let peerConnections  = {};
  let localStream      = null;
  let remoteStreams    = {};
  let currentCallId    = null;
  let callTimeout      = null;
  let isCallActive     = false;
  let iceQueues        = {};
  let isAudioMuted     = false;
  let isVideoOff       = false;
  let currentCallType  = null;
  let currentFacingMode = 'user';

  // ======================
  // HELPERS
  // ======================
  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  async function addLocalTracks(pc, stream) {
    for (const t of stream.getTracks()) {
      pc.addTrack(t, stream);
    }
  }

  function attachRemoteStream(userId, stream) {
    remoteStreams[userId] = stream;
    if (currentCallType === 'video') {
      addVideoElement('remote', userId, stream);
    } else {
      addAudioElement(userId);
    }
  }

  async function establishPeerConnection(userId, isInitiator = false) {
    if (!isCallActive || peerConnections[userId]) return;
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        // add TURN servers here if you have them
      ]
    });
    peerConnections[userId] = pc;

    pc.oniceconnectionstatechange = () => {
      if (['disconnected', 'failed'].includes(pc.iceConnectionState)) {
        removePeerConnection(userId);
      }
    };

    // modern
    pc.ontrack = e => {
      const s = e.streams[0] || new MediaStream([e.track]);
      attachRemoteStream(userId, s);
    };
    // legacy
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
      } catch (err) {
        console.error('negotiation error', err);
      }
    };

    if (localStream) {
      if ('addStream' in pc) {
        pc.addStream(localStream);
      } else {
        await addLocalTracks(pc, localStream);
      }
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
    for (const c of queue) {
      await pc.addIceCandidate(c).catch(console.error);
    }
    if (iceQueues[currentCallId]) {
      iceQueues[currentCallId][userId] = [];
    }
  }

  // ======================
  // UI FUNCTIONS
  // ======================
  function initDarkMode() {
    const dark = localStorage.getItem('darkMode') === 'true';
    document.body.classList.toggle('dark', dark);
    chatMessages.classList.toggle('dark-bg', dark);
  }
  themeBtn.onclick = () => {
    const dark = !document.body.classList.toggle('dark');
    localStorage.setItem('darkMode', dark);
    chatMessages.classList.toggle('dark-bg', dark);
  };

  muteBtn.onclick = () => {
    isMuted = !isMuted;
    localStorage.setItem('isMuted', isMuted);
    muteBtn.innerHTML = isMuted
      ? '<i class="fas fa-bell-slash"></i>'
      : '<i class="fas fa-bell"></i>';
  };
  muteBtn.innerHTML = isMuted
    ? '<i class="fas fa-bell-slash"></i>'
    : '<i class="fas fa-bell"></i>';

  function addMessage(msg) {
    // remove typing indicators
    document.querySelectorAll('.typing-indicator').forEach(el => el.remove());

    const el       = document.createElement('div');
    const isMe     = msg.username === username;
    const isSystem = msg.username === 'ChatApp Bot';

    el.id        = msg.id;
    el.className = `message ${isMe ? 'you' : 'other'}${isSystem ? ' system' : ''}`;

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
        ${isMe ? '<span class="prompt-sign">></span>' : ''}
        <strong>${msg.username}</strong>
        <span class="message-time">${msg.time}</span>
      </div>
      <div class="text">${msg.text}</div>`;

    if (isMe) {
      const seen     = msg.seenBy || [];
      const seenIcon = seen.length > 1 ? '✓✓' : '✓';
      const seenNames = seen.map(u => (u === username ? 'You' : u)).join(', ');
      html += `
        <div class="message-status">
          <span class="seen-icon">${seenIcon}</span>
          ${seenNames ? `<span class="seen-users">${seenNames}</span>` : ''}
        </div>`;
    }

    el.innerHTML = html;
    if (!isSystem) {
      el.onclick = () => {
        const user = el.querySelector('.meta strong').textContent;
        const text = el.querySelector('.text').textContent;
        setupReply(user, el.id, text);
      };
    }

    chatMessages.appendChild(el);
    setTimeout(
      () =>
        chatMessages.scrollTo({
          top: chatMessages.scrollHeight,
          behavior: 'smooth'
        }),
      20
    );
  }

  function setupReply(user, msgID, text) {
    replyTo = { id: msgID, username: user, text };
    replyUserElem.textContent = user;
    replyTextElem.textContent = text.length > 30 ? text.substr(0, 30) + '...' : text;
    replyPreview.classList.remove('d-none');
    msgInput.focus();
  }
  cancelReplyBtn.onclick = e => {
    e.stopPropagation();
    replyTo = null;
    replyPreview.classList.add('d-none');
  };

  // typing
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
      d.innerHTML = `
        <div class="dots">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
        <span class="typing-text">${user} is typing...</span>`;
      chatMessages.appendChild(d);
      chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
    }
  }

  // ======================
  // CALL UI FUNCTIONS
  // ======================
  function showCallingUI(callType) {
    videoCallContainer.innerHTML = `
      <div class="calling-ui">
        <div class="calling-spinner"></div>
        <div class="calling-text">Calling ${callType === 'audio' ? '(Audio)' : '(Video)'}...</div>
        <button id="cancel-call-btn" class="btn btn-danger">
          <i class="fas fa-phone-slash"></i> Cancel
        </button>
      </div>`;
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
        <div id="video-grid" class="video-grid"></div>
        <div class="video-controls">
          <button id="toggle-audio-btn" class="control-btn audio-btn">
            <i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>
          </button>
          <button id="end-call-btn" class="control-btn end-btn">
            <i class="fas fa-phone-slash"></i>
          </button>
          ${callType === 'video'
            ? `<button id="toggle-video-btn" class="control-btn video-btn">
                 <i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>
               </button>
               <button id="flip-camera-btn" class="control-btn flip-btn">
                 <i class="fas fa-camera-retro"></i>
               </button>`
            : ''}
        </div>
      </div>`;

    videoCallContainer.classList.remove('d-none');
    document.getElementById('toggle-audio-btn').onclick = toggleAudio;
    document.getElementById('end-call-btn').onclick = endCall;
    if (callType === 'video') {
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

  function showCallEndedUI(msg) {
    const div = document.createElement('div');
    div.className = 'call-ended-alert';
    div.innerHTML = `
      <div class="alert-content">
        <p>${msg}</p>
        <button id="close-alert-btn" class="btn btn-primary">OK</button>
      </div>`;
    document.body.appendChild(div);
    document.getElementById('close-alert-btn').onclick = () => div.remove();
  }

  // ======================
  // MEDIA ELEMENTS
  // ======================
  function addVideoElement(type, userId, stream, isLocal = false) {
    const videoGrid = document.getElementById('video-grid');
    if (!videoGrid) return;
    const existing = document.getElementById(`${type}-container-${userId}`);
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.className = `video-container ${isLocal ? 'local-video-container' : ''}`;
    container.id = `${type}-container-${userId}`;

    const video = document.createElement('video');
    video.id = `${type}-video-${userId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;
    if (isLocal && currentCallType === 'video') {
      video.style.transform = 'scaleX(-1)';
    }

    const label = document.createElement('div');
    label.className = 'video-user-label';
    label.textContent = userId === username ? 'You' : userId;

    container.appendChild(video);
    container.appendChild(label);
    videoGrid.appendChild(container);

    video.srcObject = stream;
    video.onloadedmetadata = () => video.play().catch(console.error);
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

  function updateMediaButtons() {
    const aBtn = document.getElementById('toggle-audio-btn');
    const vBtn = document.getElementById('toggle-video-btn');
    if (aBtn) aBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
    if (vBtn) vBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
  }

  async function toggleAudio() {
    isAudioMuted = !isAudioMuted;
    localStream.getAudioTracks().forEach(t => (t.enabled = !isAudioMuted));
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
    localStream.getVideoTracks().forEach(t => (t.enabled = !isVideoOff));
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
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: currentFacingMode }
      });
      localStream.getTracks().forEach(track => localStream.removeTrack(track));
      newStream.getTracks().forEach(track => localStream.addTrack(track));

      Object.values(peerConnections).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track.kind === 'video');
        if (sender) sender.replaceTrack(localStream.getVideoTracks()[0]);
      });

      const localVideo = document.getElementById(`local-video-${username}`);
      if (localVideo) localVideo.srcObject = localStream;
    } catch (err) {
      console.error('Error flipping camera:', err);
    }
  }

  // ======================
  // CALL MANAGEMENT
  // ======================
  async function startCall(callType) {
    if (isCallActive) return;

    try {
      const test = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video' ? { facingMode: 'user' } : false
      });
      test.getTracks().forEach(t => t.stop());
    } catch (err) {
      return alert(
        `Please allow ${
          callType === 'video' ? 'camera and microphone' : 'microphone'
        } access.`
      );
    }

    isCallActive = true;
    currentCallType = callType;
    currentCallId = uuidv4();
    iceQueues[currentCallId] = {};

    showCallingUI(callType);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video' ? { facingMode: 'user' } : false
      });
      showCallUI(callType);
      socket.emit('call-initiate', {
        room,
        callId: currentCallId,
        callType,
        caller: username
      });

      callTimeout = setTimeout(() => {
        if (Object.keys(peerConnections).length === 0) {
          endCall();
          showCallEndedUI('No one answered');
        }
      }, 45000);
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

    const accept = confirm(`${caller} is calling (${callType}). Accept?`);
    if (!accept) {
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
    } catch (err) {
      console.error('Error accepting call:', err);
      endCall();
    }
  }

  function endCall() {
    Object.keys(peerConnections).forEach(removePeerConnection);

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    isCallActive = false;
    currentCallId = null;
    currentCallType = null;
    clearTimeout(callTimeout);
    hideCallUI();

    socket.emit('end-call', { room, callId: currentCallId });
  }

  function removePeerConnection(userId) {
    if (peerConnections[userId]) {
      peerConnections[userId].close();
      delete peerConnections[userId];
    }
    const vidC = document.getElementById(`remote-container-${userId}`);
    if (vidC) vidC.remove();
    const audC = document.getElementById(`audio-container-${userId}`);
    if (audC) audC.remove();
    delete remoteStreams[userId];
  }

  // ======================
  // SOCKET HANDLERS
  // ======================
  socket.on('connect', () => socket.emit('joinRoom', { username, room }));

  socket.on('message', msg => {
    if (msg.username !== username && !isMuted) notificationSound.play();
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
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { answer, room, callId, targetUser: userId });
  });

  socket.on('answer', ({ answer, userId, callId }) => {
    if (callId !== currentCallId) return;
    peerConnections[userId]?.setRemoteDescription(answer);
  });

  socket.on('ice-candidate', ({ candidate, userId, callId }) => {
    if (!peerConnections[userId]) {
      iceQueues[callId]      = iceQueues[callId] || {};
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
        const initiator = participants.indexOf(username) < participants.indexOf(uid);
        establishPeerConnection(uid, initiator);
      }
    });
  });

  socket.on('end-call', () => {
    endCall();
    showCallEndedUI('Call ended');
  });

  socket.on('reject-call', ({ reason }) => {
    endCall();
    showCallEndedUI(reason === 'busy' ? 'User busy' : 'Call rejected');
  });

  socket.on('user-left-call', ({ userId }) => removePeerConnection(userId));

  // ======================
  // CHAT FORM SUBMIT
  // ======================
  document.getElementById('chat-form').onsubmit = e => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text) return;
    socket.emit('chatMessage', { text, replyTo, room });
    msgInput.value = '';
    replyTo = null;
    replyPreview.classList.add('d-none');
  };

  // ======================
  // CALL BUTTONS
  // ======================
  videoCallBtn.onclick = () => startCall('video');
  audioCallBtn.onclick = () => startCall('audio');

  // ======================
  // CLEANUP ON UNLOAD
  // ======================
  window.addEventListener('beforeunload', () => {
    if (isCallActive) socket.emit('end-call', { room, callId: currentCallId });
  });

  // ======================
  // INIT
  // ======================
  (function init() {
    if (!username || !room) {
      alert('Missing username or room!');
      return;
    }
    initDarkMode();
    roomNameElem.textContent = room;

    // append video CSS
    const style = document.createElement('style');
    style.textContent = `
      .video-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit,minmax(300px,1fr));
        gap: 10px;
        padding: 10px;
        width: 100%; height: calc(100% - 60px);
        overflow-y: auto;
      }
      .video-container { position: relative; background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 4/3; }
      .video-container video { width:100%; height:100%; object-fit:cover; }
      .video-user-label { position:absolute; bottom:5px; left:5px; color:#fff; background:rgba(0,0,0,0.5); padding:2px 8px; border-radius:4px; font-size:12px; }
      .local-video-container { order:-1; }
      .audio-container { display:flex; flex-direction:column; align-items:center; justify-content:center; background:#f0f0f0; border-radius:8px; padding:20px; }
      .audio-icon { font-size:24px; margin-bottom:10px; }
    `;
    document.head.appendChild(style);
  })();

}); // end DOMContentLoaded
