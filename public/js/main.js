const socket = io({ 
  reconnection: true, 
  reconnectionAttempts: 5, 
  reconnectionDelay: 1000 
});

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
const audioCallBtn = document.getElementById('audio-call-btn');
const videoCallContainer = document.getElementById('video-call-container');

// Audio Elements
const notificationSound = new Audio('/sounds/notification.mp3');
const callSound = new Audio('/sounds/call.mp3');

// Query Params
const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });

// State Variables
let replyTo = null;
let isMuted = localStorage.getItem('isMuted') === 'true';
let lastTypingUpdate = 0;
const SWIPE_THRESHOLD = 60;
let touchStartX = 0;
let touchEndX = 0;

// WebRTC Variables
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

// Enhanced ICE Configuration with working TURN servers
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { 
      urls: 'turn:numb.viagenie.ca',
      credential: 'muazkh',
      username: 'webrtc@live.com'
    },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:turn.bistri.com:80',
      credential: 'homeo',
      username: 'homeo'
    }
  ],
  iceTransportPolicy: 'all',
  iceCandidatePoolSize: 10
};

// Helper Functions
const uuidv4 = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
};

// ======================
// UI Functions
// ======================

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

// ======================
// Swipe to Reply Functionality
// ======================

function setupSwipeToReply() {
  chatMessages.addEventListener('touchstart', (e) => {
    if (e.target.closest('.message')) {
      touchStartX = e.changedTouches[0].screenX;
    }
  }, { passive: true });

  chatMessages.addEventListener('touchend', (e) => {
    if (!e.target.closest('.message')) return;
    
    touchEndX = e.changedTouches[0].screenX;
    const messageElement = e.target.closest('.message');
    
    if (Math.abs(touchEndX - touchStartX) > SWIPE_THRESHOLD) {
      if (touchEndX < touchStartX) {
        const user = messageElement.querySelector('.meta strong')?.textContent;
        const text = messageElement.querySelector('.text')?.textContent;
        const msgID = messageElement.id;
        
        if (user && text) {
          setupReply(user, msgID, text);
          messageElement.style.transform = 'translateX(-10px)';
          setTimeout(() => {
            messageElement.style.transform = '';
          }, 300);
        }
      }
    }
  }, { passive: true });

  // Mouse support for desktop
  chatMessages.addEventListener('mousedown', (e) => {
    if (e.target.closest('.message')) {
      touchStartX = e.screenX;
    }
  });

  chatMessages.addEventListener('mouseup', (e) => {
    if (!e.target.closest('.message')) return;
    
    const mouseUpX = e.screenX;
    const messageElement = e.target.closest('.message');
    
    if (Math.abs(mouseUpX - touchStartX) > SWIPE_THRESHOLD) {
      if (mouseUpX < touchStartX) {
        const user = messageElement.querySelector('.meta strong')?.textContent;
        const text = messageElement.querySelector('.text')?.textContent;
        const msgID = messageElement.id;
        
        if (user && text) {
          setupReply(user, msgID, text);
          messageElement.classList.add('swipe-feedback');
          setTimeout(() => {
            messageElement.classList.remove('swipe-feedback');
          }, 300);
        }
      }
    }
  });
}

// ======================
// Chat Functions
// ======================

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
// Video/Audio Elements
// ======================

function addVideoElement(type, userId, stream, isLocal = false) {
  const videoGrid = document.getElementById('video-grid');
  if (!videoGrid) {
    console.error('Video grid not found!');
    return null;
  }

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
  
  video.onloadedmetadata = () => {
    video.play().catch(e => console.error('Video play failed:', e));
  };

  console.log(`Created ${type} video element for ${userId}`);
  return video;
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

// ======================
// Call UI Functions
// ======================

function showCallingUI(callType) {
  videoCallContainer.innerHTML = `
    <div class="calling-ui">
      <div class="calling-spinner"></div>
      <div class="calling-text">Calling ${callType === 'audio' ? '(Audio)' : '(Video)'}...</div>
      <button id="cancel-call-btn" class="btn btn-danger"><i class="fas fa-phone-slash"></i> Cancel</button>
    </div>
  `;
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
      <div id="video-grid" class="video-grid">
        <!-- Videos will be added dynamically -->
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
        </button>
        <button id="flip-camera-btn" class="control-btn flip-btn">
          <i class="fas fa-camera-retro"></i>
        </button>
        ` : ''}
      </div>
    </div>
  `;

  videoCallContainer.classList.remove('d-none');

  document.getElementById('toggle-audio-btn').onclick = toggleAudio;
  document.getElementById('end-call-btn').onclick = endCall;
  if (callType === 'video') {
    document.getElementById('toggle-video-btn').onclick = toggleVideo;
    document.getElementById('flip-camera-btn').onclick = flipCamera;
  }

  if (callType === 'video' && localStream) {
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
    </div>
  `;
  document.body.appendChild(div);
  document.getElementById('close-alert-btn').onclick = () => div.remove();
}

// ======================
// Media Controls
// ======================

function updateMediaButtons() {
  const aBtn = document.getElementById('toggle-audio-btn');
  const vBtn = document.getElementById('toggle-video-btn');
  if (aBtn) aBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
  if (vBtn) vBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
}

async function toggleAudio() {
  isAudioMuted = !isAudioMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = !isAudioMuted);
  }
  updateMediaButtons();
  
  if (isCallActive && currentCallId) {
    socket.emit('mute-state', { 
      room, 
      callId: currentCallId,
      isAudioMuted,
      userId: username
    });
  }
}

async function toggleVideo() {
  isVideoOff = !isVideoOff;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
  }
  updateMediaButtons();
  
  if (isCallActive && currentCallId) {
    socket.emit('video-state', { 
      room, 
      callId: currentCallId,
      isVideoOff,
      userId: username
    });
  }
}

async function flipCamera() {
  if (!localStream || currentCallType !== 'video') return;
  
  try {
    localStream.getVideoTracks().forEach(track => track.stop());
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: currentFacingMode }
    });
    
    localStream.getVideoTracks().forEach(track => localStream.removeTrack(track));
    newStream.getVideoTracks().forEach(track => localStream.addTrack(track));
    
    Object.keys(peerConnections).forEach(userId => {
      const sender = peerConnections[userId].getSenders().find(s => s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(localStream.getVideoTracks()[0]);
      }
    });
    
    const localVideo = document.getElementById(`local-video-${username}`);
    if (localVideo) {
      localVideo.srcObject = localStream;
    }
  } catch (err) {
    console.error('Error flipping camera:', err);
  }
}

// ======================
// Peer Connection Management (FIXED VERSION)
// ======================

async function establishPeerConnection(userId, isInitiator = false) {
  if (peerConnections[userId]) {
    console.log(`Already have connection with ${userId}`);
    return;
  }

  console.log(`Creating peer connection with ${userId}`);
  const peerConnection = new RTCPeerConnection(ICE_CONFIG);
  peerConnections[userId] = peerConnection;

  // Enhanced connection state handling
  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    console.log(`ICE connection state with ${userId}: ${state}`);
    
    if (state === 'failed') {
      console.warn('ICE connection failed, restarting ICE');
      peerConnection.restartIce();
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log(`Connection state with ${userId}: ${state}`);
    
    if (state === 'connected') {
      console.log(`Successfully connected to ${userId}`);
    } else if (['disconnected', 'failed'].includes(state)) {
      console.warn(`Connection with ${userId} ${state}`);
      setTimeout(() => {
        if (peerConnection.connectionState !== 'connected') {
          removePeerConnection(userId);
        }
      }, 2000);
    }
  };

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
      console.log(`Added local ${track.kind} track`);
    });
  }

  // Handle incoming media - FIXED VERSION
  peerConnection.ontrack = (e) => {
    console.log('Remote track received:', e.streams);
    
    if (!e.streams || e.streams.length === 0) {
      console.warn('No streams in track event');
      return;
    }

    const stream = e.streams[0];
    remoteStreams[userId] = stream;

    // Debug all received tracks
    stream.getTracks().forEach(track => {
      console.log(`Remote ${track.kind} track:`, track.readyState);
      track.onended = () => console.log(`${track.kind} track ended`);
    });

    if (currentCallType === 'video') {
      let videoElem = document.getElementById(`remote-video-${userId}`);
      if (!videoElem) {
        videoElem = addVideoElement('remote', userId, stream);
      } else {
        videoElem.srcObject = stream;
      }
      
      videoElem.onloadedmetadata = () => {
        videoElem.play().catch(e => console.error('Video play error:', e));
      };
    } else {
      if (!document.getElementById(`audio-container-${userId}`)) {
        addAudioElement(userId);
      }
    }
  };

  // ICE Candidate handling
  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      console.log('Sending ICE candidate to', userId);
      socket.emit('ice-candidate', {
        candidate: e.candidate,
        room,
        callId: currentCallId,
        targetUser: userId
      });
    } else {
      console.log('ICE gathering complete');
    }
  };

  // Create offer if initiator
  if (isInitiator) {
    try {
      console.log(`Creating offer for ${userId}`);
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: currentCallType === 'video'
      });
      await peerConnection.setLocalDescription(offer);
      
      socket.emit('offer', {
        offer,
        room,
        callId: currentCallId,
        targetUser: userId
      });
    } catch (err) {
      console.error('Error creating offer:', err);
    }
  }

  // Process queued ICE candidates
  if (iceQueues[currentCallId]?.[userId]?.length > 0) {
    console.log(`Processing ${iceQueues[currentCallId][userId].length} queued ICE candidates`);
    for (const candidate of iceQueues[currentCallId][userId]) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('Error adding queued ICE candidate:', e);
      }
    }
    iceQueues[currentCallId][userId] = [];
  }
}

function removePeerConnection(userId) {
  if (peerConnections[userId]) {
    peerConnections[userId].close();
    delete peerConnections[userId];
  }
  
  const videoContainer = document.getElementById(`remote-container-${userId}`);
  if (videoContainer) videoContainer.remove();
  
  const audioContainer = document.getElementById(`audio-container-${userId}`);
  if (audioContainer) audioContainer.remove();
  
  delete remoteStreams[userId];
}

function endCall() {
  console.log('Ending call');
  
  Object.keys(peerConnections).forEach(userId => {
    removePeerConnection(userId);
  });
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  const localVideoContainer = document.getElementById(`local-container-${username}`);
  if (localVideoContainer) localVideoContainer.remove();

  isCallActive = false;
  currentCallId = null;
  currentCallType = null;
  clearTimeout(callTimeout);
  hideCallUI();
  
  socket.emit('end-call', { room, callId: currentCallId });
}

// ======================
// Call Management
// ======================

async function startCall(callType) {
  if (isCallActive) return;
  
  try {
    // Test permissions first
    const mediaConstraints = {
      audio: true,
      video: callType === 'video' ? { facingMode: 'user' } : false
    };
    const testStream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
    testStream.getTracks().forEach(t => t.stop());
  } catch {
    return alert(`Please allow ${callType === 'video' ? 'camera and microphone' : 'microphone'} access to start a call.`);
  }

  isCallActive = true;
  currentCallType = callType;
  currentCallId = uuidv4();
  iceQueues[currentCallId] = {};

  showCallingUI(callType);

  try {
    // Get the actual stream
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

  const accept = confirm(`${caller} is ${callType === 'audio' ? 'audio' : 'video'} calling. Accept?`);
  if (!accept) {
    socket.emit('reject-call', { room, callId });
    return;
  }

  isCallActive = true;
  currentCallType = callType;
  currentCallId = callId;
  iceQueues[callId] = {};

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video' ? { facingMode: 'user' } : false
    });
    
    console.log('Obtained media stream with tracks:', 
      `Audio: ${stream.getAudioTracks().length}, ` +
      `Video: ${stream.getVideoTracks().length}`);

    localStream = stream;
    showCallUI(callType);
    socket.emit('accept-call', { room, callId });
    socket.emit('get-call-participants', { room, callId });

  } catch (err) {
    console.error('Call setup failed:', err);
    alert(`Failed to start call: ${err.message}`);
    endCall();
  }
}

// ======================
// Socket Event Handlers
// ======================

socket.on('connect', () => {
  console.log('Connected to server');
  socket.emit('joinRoom', { username, room });
});

socket.on('message', msg => {
  console.log('New message received');
  if (msg.username !== username && !isMuted) notificationSound.play().catch(() => {});
  addMessage(msg);
});

socket.on('showTyping', ({ username: u }) => {
  console.log(`${u} is typing`);
  u !== username && showTypingIndicator(u);
});

socket.on('stopTyping', () => {
  console.log('Typing stopped');
  document.querySelectorAll('.typing-indicator').forEach(el => el.remove());
});

socket.on('incoming-call', handleIncomingCall);

socket.on('call-accepted', async ({ callId, userId }) => {
  console.log(`Call accepted by ${userId}`);
  if (callId !== currentCallId || !isCallActive) return;
  
  await establishPeerConnection(userId, true);
});

socket.on('call-participants', ({ participants, callId }) => {
  console.log(`Call participants: ${participants.join(', ')}`);
  if (callId !== currentCallId || !isCallActive) return;
  
  participants.forEach(async userId => {
    if (userId !== username && !peerConnections[userId]) {
      console.log(`Establishing connection with existing participant ${userId}`);
      await establishPeerConnection(userId, true);
    }
  });
});

socket.on('offer', async ({ offer, userId, callId }) => {
  console.log(`Offer received from ${userId}`);
  if (callId !== currentCallId || !isCallActive) return;
  
  if (peerConnections[userId]) {
    console.log(`Already have connection with ${userId}, ignoring offer`);
    return;
  }
  
  await establishPeerConnection(userId);
  
  const peerConnection = peerConnections[userId];
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('answer', { 
      answer, 
      room, 
      callId,
      targetUser: userId
    });
    
    if (iceQueues[callId]?.[userId]?.length > 0) {
      console.log(`Processing ${iceQueues[callId][userId].length} queued ICE candidates`);
      for (const candidate of iceQueues[callId][userId]) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding queued ICE candidate:', e);
        }
      }
      iceQueues[callId][userId] = [];
    }
  } catch (err) {
    console.error('Offer handling error:', err);
  }
});

socket.on('answer', async ({ answer, userId, callId }) => {
  console.log(`Answer received from ${userId}`);
  if (callId !== currentCallId || !isCallActive || !peerConnections[userId]) return;
  
  try {
    await peerConnections[userId].setRemoteDescription(new RTCSessionDescription(answer));
    
    // Check if we have video and add if needed
    const pc = peerConnections[userId];
    const receivers = pc.getReceivers();
    receivers.forEach(receiver => {
      if (receiver.track && receiver.track.kind === 'video' && !remoteStreams[userId]) {
        const stream = new MediaStream([receiver.track]);
        remoteStreams[userId] = stream;
        addVideoElement('remote', userId, stream);
      }
    });

    // Process queued candidates
    if (iceQueues[callId]?.[userId]?.length > 0) {
      for (const candidate of iceQueues[callId][userId]) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding queued ICE candidate:', e);
        }
      }
      iceQueues[callId][userId] = [];
    }
  } catch (err) {
    console.error('Answer handling error:', err);
  }
});

socket.on('ice-candidate', async ({ candidate, userId, callId }) => {
  console.log(`ICE candidate received from ${userId}`);
  if (callId !== currentCallId || !isCallActive) return;
  
  if (!peerConnections[userId]) {
    console.log(`Queueing ICE candidate for ${userId}`);
    if (!iceQueues[callId]) iceQueues[callId] = {};
    if (!iceQueues[callId][userId]) iceQueues[callId][userId] = [];
    iceQueues[callId][userId].push(candidate);
    return;
  }
  
  try {
    await peerConnections[userId].addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Error adding ICE candidate:', err);
  }
});

socket.on('user-joined-call', ({ userId }) => {
  console.log(`${userId} joined the call`);
  if (!isCallActive || userId === username) return;
});

socket.on('user-left-call', ({ userId }) => {
  console.log(`${userId} left the call`);
  if (!isCallActive) return;
  removePeerConnection(userId);
});

socket.on('call-ended', () => {
  console.log('Call ended by remote peer');
  endCall();
  showCallEndedUI('Call ended');
});

socket.on('call-rejected', ({ reason }) => {
  console.log(`Call rejected: ${reason}`);
  endCall();
  showCallEndedUI(reason === 'busy' ? 'User is busy' : 'Call rejected');
});

socket.on('mute-state', ({ userId, isAudioMuted: muted }) => {
  console.log(`${userId} ${muted ? 'muted' : 'unmuted'} audio`);
  const userLabel = document.querySelector(`#remote-container-${userId} .video-user-label`);
  if (userLabel) {
    userLabel.innerHTML = `${userId === username ? 'You' : userId} ${muted ? '(muted)' : ''}`;
  }
});

socket.on('video-state', ({ userId, isVideoOff: videoOff }) => {
  console.log(`${userId} ${videoOff ? 'disabled' : 'enabled'} video`);
  const videoElem = document.getElementById(`remote-video-${userId}`);
  if (videoElem) {
    videoElem.style.display = videoOff ? 'none' : 'block';
  }
});

// ======================
// Event Listeners
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

videoCallBtn.onclick = () => startCall('video');
audioCallBtn.onclick = () => startCall('audio');

window.addEventListener('beforeunload', () => {
  if (isCallActive) socket.emit('end-call', { room, callId: currentCallId });
});

// Initialize
(function init() {
  if (!username || !room) return alert('Missing username or room!');
  initDarkMode();
  roomNameElem.textContent = room;
  setupSwipeToReply();
  console.log('Application initialized');
})();