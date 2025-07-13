// Initialize Socket.IO first
const socket = io({
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});
console.log("Socket initialized:", socket.id);

// Temporarily disable service worker during development
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => registration.unregister());
  });
}

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
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const endCallBtn = document.getElementById('end-call-btn');
const toggleAudioBtn = document.getElementById('toggle-audio-btn');
const toggleVideoBtn = document.getElementById('toggle-video-btn');

// Audio Elements
const notificationSound = new Audio('/sounds/notification.mp3');
const callSound = new Audio('/sounds/call.mp3');

// State Variables
const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true }) || {};
let replyTo = null;
let isMuted = localStorage.getItem('isMuted') === 'true';
const typingUsers = new Set();
let typingIndicator = null;
let lastTypingUpdate = 0;
let touchStartX = 0;
const SWIPE_THRESHOLD = 60;

// WebRTC Variables
let localStream;
let remoteStream;
let peerConnection;
let isAudioMuted = false;
let isVideoOff = false;
let iceCandidatesQueue = [];
let currentCallId = null;
let callTimeout = null;
let isCallActive = false;

// ICE Servers Configuration (updated with more reliable servers)
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: 'turn:global.turn.server:3478',
      username: 'username',
      credential: 'credential'
    }
  ],
  iceCandidatePoolSize: 10
};

// UUID generator for call IDs
const uuidv4 = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Initialize the app
function init() {
  if (!username || !room) {
    alert('Missing username or room parameters');
    return;
  }

  initDarkMode();
  setupKeyboardHandling();
  scrollToBottom(true);
  initMessageHandlers();
  fixInputBox();
  setupEventListeners();
  updateMediaButtons();

  // Set room name in header
  roomNameElem.textContent = room || 'Global Chat';
}

/* [Previous functions remain the same until video call section] */

/* ====================== */
/* VIDEO CALL FUNCTIONALITY - UPDATED */
/* ====================== */

// Initialize video call
async function startVideoCall() {
  try {
    if (isCallActive) {
      console.log("Call already active");
      return;
    }

    if (!await checkMediaPermissions()) return;

    currentCallId = uuidv4();
    console.log("Starting video call with ID:", currentCallId);
    isCallActive = true;

    // Create peer connection with better error handling
    try {
      peerConnection = new RTCPeerConnection(configuration);
    } catch (error) {
      console.error("Failed to create peer connection:", error);
      throw new Error("Could not establish connection");
    }

    // Get local media stream with better constraints
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (error) {
      console.error("Failed to get media devices:", error);
      throw new Error("Could not access camera/microphone");
    }

    // Add tracks to connection with error handling
    localStream.getTracks().forEach(track => {
      try {
        peerConnection.addTrack(track, localStream);
      } catch (error) {
        console.error("Failed to add track:", error);
      }
    });

    // Set up remote stream handler
    peerConnection.ontrack = event => {
      if (!event.streams || event.streams.length === 0) return;

      remoteStream = event.streams[0];
      if (remoteVideo) {
        remoteVideo.srcObject = remoteStream;
        remoteVideo.onloadedmetadata = () => {
          remoteVideo.play().catch(e => console.log("Remote video play error:", e));
        };
      }
      showVideoCallUI();
    };

    // ICE candidate handler
    peerConnection.onicecandidate = event => {
      if (event.candidate && currentCallId) {
        socket.emit('ice-candidate', {
          candidate: event.candidate,
          room,
          callId: currentCallId
        });
      }
    };

    // Improved connection state handling
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log('Connection state:', state);

      if (state === 'connected') {
        clearTimeout(callTimeout);
      } else if (state === 'disconnected' || state === 'failed') {
        endVideoCall();
        alert('Call disconnected');
      }
    };

    // Create offer with better error handling
    let offer;
    try {
      offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await peerConnection.setLocalDescription(offer);
    } catch (error) {
      console.error("Offer creation error:", error);
      throw new Error("Failed to initiate call");
    }

    // Show calling UI
    showCallingUI();

    // Send offer to other users in room
    socket.emit('video-call-initiate', {
      offer,
      room,
      callId: currentCallId,
      caller: username
    });

    // Set timeout for unanswered call
    callTimeout = setTimeout(() => {
      if (!remoteStream) {
        endVideoCall();
        alert('Call was not answered');
      }
    }, 30000);

  } catch (error) {
    console.error('Error starting call:', error);
    endVideoCall();
    alert('Failed to start call: ' + error.message);
  }
}

// Handle incoming call with better validation
async function handleIncomingCall(data) {
  if (!data || !data.offer || !data.callId || !data.caller) {
    console.error("Invalid call data received");
    return;
  }

  if (peerConnection || isCallActive) {
    socket.emit('reject-call', { room, callId: data.callId, reason: 'busy' });
    return;
  }

  // Show better call UI
  const acceptCall = confirm(`${data.caller} is calling. Accept?`);

  if (!acceptCall) {
    socket.emit('reject-call', { room, callId: data.callId });
    return;
  }

  try {
    currentCallId = data.callId;
    isCallActive = true;

    // Get local media with better error handling
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    }).catch(error => {
      console.error("Failed to get media devices:", error);
      throw new Error("Could not access camera/microphone");
    });

    localVideo.srcObject = localStream;
    localVideo.onloadedmetadata = () => {
      localVideo.play().catch(e => console.log("Local video play error:", e));
    };

    // Create peer connection
    peerConnection = new RTCPeerConnection(configuration);

    // Add local tracks
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Set up remote stream handler
    peerConnection.ontrack = event => {
      if (!event.streams || event.streams.length === 0) return;

      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
      remoteVideo.onloadedmetadata = () => {
        remoteVideo.play().catch(e => console.log("Remote video play error:", e));
      };
      showVideoCallUI();
    };

    // ICE candidate handler
    peerConnection.onicecandidate = event => {
      if (event.candidate && currentCallId) {
        socket.emit('ice-candidate', {
          candidate: event.candidate,
          room,
          callId: currentCallId
        });
      }
    };

    // Connection state handler
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log('Connection state:', state);

      if (state === 'connected') {
        clearTimeout(callTimeout);
      } else if (state === 'disconnected' || state === 'failed') {
        endVideoCall();
        alert('Call disconnected');
      }
    };

    // Set remote description
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

    // Create answer
    const answer = await peerConnection.createAnswer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    await peerConnection.setLocalDescription(answer);

    // Send answer to caller
    socket.emit('video-answer', {
      answer,
      room,
      callId: currentCallId
    });

    // Process any queued ICE candidates
    processQueuedCandidates();

  } catch (error) {
    console.error('Error handling incoming call:', error);
    socket.emit('reject-call', { room, callId: data.callId });
    endVideoCall();
    alert('Failed to accept call: ' + error.message);
  }
}

// Improved end video call function
function endVideoCall() {
  console.log("Ending video call");

  // Stop all media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      track.stop();
      track.enabled = false;
    });
    localStream = null;
  }

  if (remoteStream) {
    remoteStream.getTracks().forEach(track => {
      track.stop();
      track.enabled = false;
    });
    remoteStream = null;
  }

  // Close peer connection
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  // Clear video elements
  if (localVideo) {
    localVideo.srcObject = null;
    localVideo.onloadedmetadata = null;
  }

  if (remoteVideo) {
    remoteVideo.srcObject = null;
    remoteVideo.onloadedmetadata = null;
  }

  // Hide UI
  hideCallingUI();

  // Notify server
  if (currentCallId) {
    socket.emit('end-call', { room, callId: currentCallId });
  }

  // Reset state
  currentCallId = null;
  isCallActive = false;
  clearTimeout(callTimeout);
  callSound.pause();
  callSound.currentTime = 0;
  iceCandidatesQueue = [];
}



// Hide calling UI
function hideCallingUI() {
  videoCallContainer.classList.add('d-none');
  callSound.pause();
  callSound.currentTime = 0;
  clearTimeout(callTimeout);
}

// Toggle audio mute
function toggleAudio() {
  if (localStream) {
    const audioTracks = localStream.getAudioTracks();
    audioTracks.forEach(track => {
      track.enabled = !track.enabled;
    });
    isAudioMuted = !isAudioMuted;
    updateMediaButtons();
  }
}

// Toggle video
function toggleVideo() {
  if (localStream) {
    const videoTracks = localStream.getVideoTracks();
    videoTracks.forEach(track => {
      track.enabled = !track.enabled;
    });
    isVideoOff = !isVideoOff;
    updateMediaButtons();
  }
}

// Check media permissions
async function checkMediaPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch (error) {
    console.error("Permission denied:", error);
    alert("Please allow camera/microphone access to make video calls!");
    return false;
  }
}

/* ====================== */
/* SOCKET.IO EVENT HANDLERS */
/* ====================== */

socket.on('connect', () => {
  console.log('Connected to server');
  socket.emit('joinRoom', { username, room });
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  if (peerConnection) {
    endVideoCall();
  }
});

// Message handling
socket.on('message', (msg) => {
  if (msg.username !== username && msg.username !== 'ChatApp Bot' && !isMuted) {
    notificationSound.play().catch(() => { });
  }
  addMessage(msg);
  initMessageHandlers();
  hideTypingIndicator();
});

socket.on('userJoined', (msg) => {
  addMessage({
    id: 'system-msg-' + Date.now(),
    username: 'ChatApp Bot',
    text: `${msg.username} has joined the chat`,
    time: msg.time
  });
});

socket.on('userLeft', (msg) => {
  addMessage({
    id: 'system-msg-' + Date.now(),
    username: 'ChatApp Bot',
    text: `${msg.username} has left the chat`,
    time: msg.time
  });
});

// Typing indicators
socket.on('showTyping', ({ username: u }) => {
  if (u !== username) {
    typingUsers.add(u);
    showTypingIndicator(u);
  }
});

socket.on('stopTyping', ({ username: u }) => {
  typingUsers.delete(u);
  if (typingUsers.size === 0) {
    hideTypingIndicator();
  } else {
    showTypingIndicator([...typingUsers][typingUsers.size - 1]);
  }
});

// Seen status updates
socket.on('messagesSeen', (updates) => {
  updates.forEach(update => {
    const message = document.getElementById(update.messageId);
    if (message) {
      const seenStatus = message.querySelector('.message-status');
      if (seenStatus) {
        const seenNames = update.seenBy.map(u => u === username ? 'You' : u).join(', ');
        seenStatus.innerHTML = `
          <span class="seen-icon">${update.seenBy.length > 1 ? '✓✓' : '✓'}</span>
          ${seenNames ? `<span class="seen-users">${seenNames}</span>` : ''}
        `;
      }
    }
  });
});

// Video call handlers
socket.on('incoming-call', handleIncomingCall);

socket.on('video-answer', async ({ answer, callId }) => {
  if (!peerConnection || currentCallId !== callId) return;

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    processQueuedCandidates();
  } catch (error) {
    console.error('Error setting remote description:', error);
    endVideoCall();
  }
});

socket.on('ice-candidate', async ({ candidate, callId }) => {
  if (!peerConnection) {
    iceCandidatesQueue.push(candidate);
    return;
  }

  if (currentCallId !== callId) return;

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error('Error adding ICE candidate:', error);
  }
});

socket.on('end-call', ({ callId }) => {
  if (currentCallId === callId || !currentCallId) {
    endVideoCall();
    alert('The other party has ended the call.');
  }
});

socket.on('reject-call', ({ callId, reason }) => {
  if (currentCallId === callId) {
    endVideoCall();
    alert(reason === 'busy' ? 'The user is busy.' : 'Call rejected.');
  }
});
/* ====================== */
/* VIDEO CALL FUNCTIONALITY - FINAL FIX */
/* ====================== */

// Initialize video call
async function startVideoCall() {
  try {
    if (isCallActive) {
      console.log("Call already active");
      return;
    }

    if (!await checkMediaPermissions()) return;

    currentCallId = uuidv4();
    console.log("Starting video call with ID:", currentCallId);
    isCallActive = true;

    // Create peer connection
    peerConnection = new RTCPeerConnection(configuration);

    // Get local media stream
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // Display local video immediately
    localVideo.srcObject = localStream;
    localVideo.muted = true; // Mute local video to avoid echo
    localVideo.play().catch(e => console.log("Local video play error:", e));

    // Add tracks to connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Set up remote stream handler
    peerConnection.ontrack = event => {
      if (!event.streams || event.streams.length === 0) return;

      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
      remoteVideo.play().catch(e => console.log("Remote video play error:", e));

      // Show both videos when remote stream is received
      showVideoCallUI();
    };

    // ICE candidate handler
    peerConnection.onicecandidate = event => {
      if (event.candidate && currentCallId) {
        socket.emit('ice-candidate', {
          candidate: event.candidate,
          room,
          callId: currentCallId
        });
      }
    };

    // Connection state handling
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log('Connection state:', state);

      if (state === 'connected') {
        clearTimeout(callTimeout);
      } else if (state === 'disconnected' || state === 'failed') {
        endVideoCall();
        showCallEndedUI('Call disconnected');
      }
    };

    // Create offer
    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    await peerConnection.setLocalDescription(offer);

    // Show calling UI
    showCallingUI();

    // Send offer to other users in room
    socket.emit('video-call-initiate', {
      offer,
      room,
      callId: currentCallId,
      caller: username
    });

    // Set timeout for unanswered call
    callTimeout = setTimeout(() => {
      if (!remoteStream) {
        endVideoCall();
        showCallEndedUI('Call was not answered');
      }
    }, 30000);

  } catch (error) {
    console.error('Error starting call:', error);
    endVideoCall();
    showCallEndedUI('Failed to start call: ' + error.message);
  }
}

// Show active call UI with proper button layout
function showVideoCallUI() {
  clearTimeout(callTimeout);
  callSound.pause();
  callSound.currentTime = 0;

  videoCallContainer.innerHTML = `
    <div class="video-grid">
      <div class="video-container">
        <video id="remote-video" autoplay playsinline class="remote-video"></video>
        <video id="local-video" autoplay playsinline muted class="local-video"></video>
      </div>
      <div class="video-controls">
        <button id="toggle-audio-btn" class="control-btn audio-btn">
          <i class="fas fa-microphone"></i>
        </button>
        <button id="end-call-btn" class="control-btn end-btn">
          <i class="fas fa-phone-slash"></i>
        </button>
        <button id="toggle-video-btn" class="control-btn video-btn">
          <i class="fas fa-video"></i>
        </button>
      </div>
    </div>
  `;

  // Update references to new elements
  const newLocalVideo = document.getElementById('local-video');
  const newRemoteVideo = document.getElementById('remote-video');
  const newToggleAudioBtn = document.getElementById('toggle-audio-btn');
  const newToggleVideoBtn = document.getElementById('toggle-video-btn');
  const newEndCallBtn = document.getElementById('end-call-btn');

  // Maintain existing streams
  if (localStream) newLocalVideo.srcObject = localStream;
  if (remoteStream) newRemoteVideo.srcObject = remoteStream;

  // Set up event listeners
  newToggleAudioBtn.addEventListener('click', toggleAudio);
  newToggleVideoBtn.addEventListener('click', toggleVideo);
  newEndCallBtn.addEventListener('click', endVideoCall);

  // Update button states
  updateMediaButtons();

  // Add CSS for proper video layout
  addVideoCallStyles();
}

// Add CSS for video call layout
function addVideoCallStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .video-call-container {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: #000;
      z-index: 1000;
      display: flex;
      flex-direction: column;
    }
    
    .video-grid {
      flex: 1;
      position: relative;
      overflow: hidden;
    }
    
    .remote-video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    
    .local-video {
      position: absolute;
      bottom: 20px;
      right: 20px;
      width: 25%;
      max-width: 200px;
      border: 2px solid #fff;
      border-radius: 8px;
      z-index: 1001;
    }
    
    .video-controls {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 30px;
      padding: 20px;
      background: rgba(0,0,0,0.5);
    }
    
    .control-btn {
      width: 50px;
      height: 50px;
      border-radius: 50%;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 20px;
      transition: all 0.2s;
    }
    
    .audio-btn {
      background: #4CAF50;
      color: white;
    }
    
    .video-btn {
      background: #2196F3;
      color: white;
    }
    
    .end-btn {
      background: #f44336;
      color: white;
      width: 60px;
      height: 60px;
    }
    
    .control-btn:hover {
      transform: scale(1.1);
    }
    
    .control-btn i {
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

// Toggle audio mute with visual feedback
function toggleAudio() {
  if (localStream) {
    const audioTracks = localStream.getAudioTracks();
    audioTracks.forEach(track => {
      track.enabled = !track.enabled;
    });
    isAudioMuted = !isAudioMuted;

    const audioBtn = document.getElementById('toggle-audio-btn');
    if (audioBtn) {
      audioBtn.innerHTML = `<i class="fas fa-microphone${isAudioMuted ? '-slash' : ''}"></i>`;
      audioBtn.style.background = isAudioMuted ? '#ff9800' : '#4CAF50';
    }
  }
}

// Toggle video with visual feedback
function toggleVideo() {
  if (localStream) {
    const videoTracks = localStream.getVideoTracks();
    videoTracks.forEach(track => {
      track.enabled = !track.enabled;
    });
    isVideoOff = !isVideoOff;

    const videoBtn = document.getElementById('toggle-video-btn');
    if (videoBtn) {
      videoBtn.innerHTML = `<i class="fas fa-video${isVideoOff ? '-slash' : ''}"></i>`;
      videoBtn.style.background = isVideoOff ? '#ff9800' : '#2196F3';
    }

    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      localVideo.style.borderColor = isVideoOff ? '#f44336' : '#fff';
    }
  }
}

// Show call ended message
function showCallEndedUI(message) {
  const alertBox = document.createElement('div');
  alertBox.className = 'call-ended-alert';
  alertBox.innerHTML = `
    <div class="alert-content">
      <p>${message}</p>
      <button id="close-alert-btn" class="btn btn-primary">OK</button>
    </div>
  `;

  document.body.appendChild(alertBox);

  document.getElementById('close-alert-btn').addEventListener('click', () => {
    alertBox.remove();
  });

  // Add styles for alert
  const style = document.createElement('style');
  style.textContent = `
    .call-ended-alert {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 2000;
    }
    
    .alert-content {
      background: white;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
      max-width: 80%;
    }
    
    .alert-content p {
      margin-bottom: 20px;
      font-size: 18px;
    }
  `;
  document.head.appendChild(style);
}



// Initialize the app
init();