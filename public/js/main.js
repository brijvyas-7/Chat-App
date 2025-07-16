// Initialize Socket.IO
const socket = io();

// DOM Elements
const chatContainer = document.querySelector('.chat-container');
const msgInput = document.getElementById('msg');
const chatMessages = document.getElementById('chat-messages');
const inputForm = document.querySelector('.input-form');
const videoCallContainer = document.getElementById('video-call-container');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

// State Variables
let peerConnection;
let localStream;
let remoteStream;
let currentCallId;
let isCallActive = false;
const callSound = new Audio('/sounds/call.mp3');

// WhatsApp-like UI Setup
function setupWhatsAppUI() {
  // Compact header
  const header = document.querySelector('header');
  header.style.height = '60px';
  header.style.padding = '10px 15px';
  
  // Compact footer
  const footer = document.querySelector('.input-container');
  footer.style.minHeight = '60px';
  footer.style.padding = '5px 10px';
  
  // Message input styling
  msgInput.style.minHeight = '40px';
  msgInput.style.maxHeight = '100px';
  msgInput.style.padding = '8px 12px';
  
  // Messages container
  chatMessages.style.paddingBottom = '60px';
  
  // Fix for iOS keyboard
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    const originalViewport = document.querySelector('meta[name="viewport"]').content;
    
    msgInput.addEventListener('focus', () => {
      document.querySelector('meta[name="viewport"]').content = 'width=device-width, initial-scale=1, maximum-scale=1';
      setTimeout(scrollToBottom, 300);
    });
    
    msgInput.addEventListener('blur', () => {
      document.querySelector('meta[name="viewport"]').content = originalViewport;
    });
  }
}

// Video Call Functions
async function startVideoCall() {
  try {
    currentCallId = Date.now().toString();
    isCallActive = true;
    
    // Get media with echo cancellation
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    
    // Create peer connection
    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    
    // Add local stream
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    // Remote stream handler
    peerConnection.ontrack = (event) => {
      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
      showVideoCallUI();
    };
    
    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    // Show calling UI for caller
    showCallingUI();
    
    // Emit call to receiver
    socket.emit('video-call', {
      offer,
      room,
      callId: currentCallId
    });
    
  } catch (error) {
    console.error('Call error:', error);
    endVideoCall();
  }
}

function showCallingUI() {
  videoCallContainer.innerHTML = `
    <div class="calling-screen">
      <div class="calling-info">Calling...</div>
      <video id="local-preview" autoplay muted></video>
      <button class="end-call-btn">
        <i class="fas fa-phone-slash"></i>
      </button>
    </div>
  `;
  
  const localPreview = document.getElementById('local-preview');
  localPreview.srcObject = localStream;
  
  document.querySelector('.end-call-btn').addEventListener('click', endVideoCall);
  videoCallContainer.style.display = 'flex';
  
  // Play call sound only for caller
  callSound.loop = true;
  callSound.play();
}

function showVideoCallUI() {
  // Stop call sound for both parties
  callSound.pause();
  callSound.currentTime = 0;
  
  videoCallContainer.innerHTML = `
    <div class="video-screen">
      <video id="remote-video" autoplay></video>
      <video id="local-video" autoplay muted></video>
      <div class="call-controls">
        <button class="mute-btn">
          <i class="fas fa-microphone"></i>
        </button>
        <button class="end-call-btn">
          <i class="fas fa-phone-slash"></i>
        </button>
        <button class="video-btn">
          <i class="fas fa-video"></i>
        </button>
      </div>
    </div>
  `;
  
  // Set video streams
  remoteVideo.srcObject = remoteStream;
  localVideo.srcObject = localStream;
  
  // Add control handlers
  document.querySelector('.mute-btn').addEventListener('click', toggleAudio);
  document.querySelector('.video-btn').addEventListener('click', toggleVideo);
  document.querySelector('.end-call-btn').addEventListener('click', endVideoCall);
  
  videoCallContainer.style.display = 'flex';
}

function endVideoCall() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
    remoteStream = null;
  }
  
  callSound.pause();
  callSound.currentTime = 0;
  videoCallContainer.style.display = 'none';
  isCallActive = false;
  
  socket.emit('end-call', { room, callId: currentCallId });
}

// Handle incoming call
socket.on('incoming-call', async ({ offer, callId }) => {
  if (isCallActive) {
    socket.emit('call-rejected', { room, callId });
    return;
  }
  
  currentCallId = callId;
  
  // Show accept/reject UI
  videoCallContainer.innerHTML = `
    <div class="incoming-call">
      <div class="caller-info">Incoming Call</div>
      <div class="call-buttons">
        <button class="accept-btn">
          <i class="fas fa-phone"></i>
        </button>
        <button class="reject-btn">
          <i class="fas fa-phone-slash"></i>
        </button>
      </div>
    </div>
  `;
  
  videoCallContainer.style.display = 'flex';
  
  // Play ringtone for receiver only
  callSound.loop = true;
  callSound.play();
  
  // Button handlers
  document.querySelector('.accept-btn').addEventListener('click', async () => {
    await acceptCall(offer, callId);
  });
  
  document.querySelector('.reject-btn').addEventListener('click', () => {
    socket.emit('call-rejected', { room, callId });
    endVideoCall();
  });
});

async function acceptCall(offer, callId) {
  try {
    isCallActive = true;
    
    // Get local media
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    
    // Create peer connection
    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    
    // Add local stream
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    // Remote stream handler
    peerConnection.ontrack = (event) => {
      remoteStream = event.streams[0];
      remoteVideo.srcObject = remoteStream;
      showVideoCallUI();
    };
    
    // Set remote description
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    
    // Create answer
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    // Send answer
    socket.emit('call-answer', {
      answer,
      room,
      callId
    });
    
    // Stop call sound
    callSound.pause();
    callSound.currentTime = 0;
    
  } catch (error) {
    console.error('Accept call error:', error);
    endVideoCall();
  }
}

// Handle call answer
socket.on('call-answer', async ({ answer, callId }) => {
  if (peerConnection && currentCallId === callId) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

// Handle ICE candidates
socket.on('ice-candidate', ({ candidate, callId }) => {
  if (peerConnection && currentCallId === callId) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// Handle call end
socket.on('call-ended', ({ callId }) => {
  if (currentCallId === callId) {
    endVideoCall();
  }
});

// Initialize the app
function init() {
  setupWhatsAppUI();
  
  // Video call button
  document.getElementById('video-call-btn').addEventListener('click', startVideoCall);
  
  // Fix input box focus
  msgInput.addEventListener('focus', () => {
    inputForm.style.width = '100%';
    setTimeout(scrollToBottom, 300);
  });
  
  msgInput.addEventListener('blur', () => {
    // Reset if needed
  });
}

// Start the app
document.addEventListener('DOMContentLoaded', init);