const socket = io({ reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });

const msgInput = document.getElementById('msg');
const chatMessages = document.getElementById('chat-messages');
const replyPreview = document.getElementById('reply-preview');
const replyUserElem = document.getElementById('reply-user');
const replyTextElem = document.getElementById('reply-text');
const typingIndicator = document.getElementById('typing-indicator');
const muteToggle = document.getElementById('mute-toggle');
const darkModeToggle = document.getElementById('dark-mode-toggle');
const videoCallBtn = document.getElementById('video-call');
const localVideo = document.getElementById('local-video');
const remoteVideosContainer = document.getElementById('remote-videos');
const callUI = document.getElementById('call-ui');

let username = prompt("Enter your name:");
let room = "global";
let replyTo = null;
let isMuted = false;
let isTyping = false;
let typingTimeout;
let isCallActive = false;
let peerConnections = {};
let localStream;
let currentCallId = null;

function appendMessage(user, text, isOwn, reply = null, seen = false) {
  const msg = document.createElement('div');
  msg.className = `message ${isOwn ? 'own' : ''}`;
  if (reply) {
    const replyDiv = document.createElement('div');
    replyDiv.className = 'reply-preview';
    replyDiv.innerHTML = `<strong>${reply.user}:</strong> ${reply.text}`;
    msg.appendChild(replyDiv);
  }
  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = text;
  msg.appendChild(content);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `${user} ${seen ? '<span class="seen">Seen</span>' : ''}`;
  msg.appendChild(meta);

  msg.addEventListener('click', () => setReply(user, text));
  msg.addEventListener('touchstart', handleSwipeStart);
  msg.addEventListener('touchend', handleSwipeEnd);

  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setReply(user, text) {
  replyTo = { user, text };
  replyUserElem.textContent = user;
  replyTextElem.textContent = text;
  replyPreview.style.display = 'flex';
}

function clearReply() {
  replyTo = null;
  replyPreview.style.display = 'none';
}

function sendMessage(e) {
  e.preventDefault();
  const msg = msgInput.value;
  if (!msg.trim()) return;
  socket.emit('chatMessage', { text: msg, reply: replyTo });
  appendMessage(username, msg, true, replyTo, true);
  msgInput.value = '';
  clearReply();
}

function showTyping(user) {
  typingIndicator.textContent = `${user} is typing...`;
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    typingIndicator.textContent = '';
  }, 2000);
}

function toggleMute() {
  isMuted = !isMuted;
  muteToggle.textContent = isMuted ? 'Unmute' : 'Mute';
  if (localStream) {
    localStream.getAudioTracks().forEach(track => (track.enabled = !isMuted));
  }
}

function toggleDarkMode() {
  document.body.classList.toggle('dark');
}

function showCallUI() {
  callUI.style.display = 'block';
}

function hideCallUI() {
  callUI.style.display = 'none';
}

function createVideoElement(id) {
  let video = document.createElement('video');
  video.id = `remote-${id}`;
  video.autoplay = true;
  video.playsInline = true;
  video.style.width = '100%';
  remoteVideosContainer.appendChild(video);
  return video;
}

async function establishPeerConnection(remoteUser, isCaller = false) {
  const peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  peerConnections[remoteUser] = peerConnection;

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
    console.log(`Added local ${track.kind} track`);
  });

  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        to: remoteUser,
        candidate: event.candidate,
        callId: currentCallId
      });
    }
  };

  peerConnection.ontrack = event => {
    let remoteVideo = document.getElementById(`remote-${remoteUser}`);
    if (!remoteVideo) {
      remoteVideo = createVideoElement(remoteUser);
    }
    remoteVideo.srcObject = event.streams[0];
  };

  if (isCaller) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', {
      to: remoteUser,
      offer,
      callId: currentCallId
    });
  }
}

function handleIncomingCall({ caller, room, callId }) {
  if (isCallActive || confirm(`Incoming video call from ${caller}. Accept?`)) {
    isCallActive = true;
    currentCallId = callId;
    showCallUI();

    navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
      localStream = stream;
      localVideo.srcObject = stream;
      socket.emit('accept-call', { room, callId });
      socket.emit('get-call-participants', { room, callId });

      socket.once('call-participants', ({ participants, callId: cid }) => {
        if (cid !== currentCallId || !isCallActive) return;
        participants.forEach(async userId => {
          if (userId !== username && !peerConnections[userId]) {
            await establishPeerConnection(userId);
          }
        });
      });
    }).catch(err => {
      console.error('Media access error on receiver side:', err);
      endCall();
    });
  } else {
    socket.emit('reject-call', { room, callId });
  }
}

function endCall() {
  isCallActive = false;
  currentCallId = null;
  hideCallUI();
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  localVideo.srcObject = null;
  remoteVideosContainer.innerHTML = '';
  socket.emit('end-call', { room });
}

msgInput.addEventListener('input', () => {
  if (!isTyping) {
    socket.emit('typing', username);
    isTyping = true;
    setTimeout(() => (isTyping = false), 1000);
  }
});

document.getElementById('chat-form').addEventListener('submit', sendMessage);
document.getElementById('cancel-reply').addEventListener('click', clearReply);
muteToggle.addEventListener('click', toggleMute);
darkModeToggle.addEventListener('click', toggleDarkMode);
videoCallBtn.addEventListener('click', () => {
  if (isCallActive) return;

  navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
    localStream = stream;
    localVideo.srcObject = stream;
    isCallActive = true;
    currentCallId = Date.now().toString();
    showCallUI();
    socket.emit('start-call', { room, callId: currentCallId });
  }).catch(err => {
    console.error('Media access error:', err);
  });
});
document.getElementById('end-call').addEventListener('click', endCall);

socket.emit('joinRoom', { username, room });

socket.on('message', ({ user, text, reply }) => {
  appendMessage(user, text, user === username, reply, user === username);
});

socket.on('typing', user => {
  if (user !== username) showTyping(user);
});

socket.on('start-call', handleIncomingCall);

socket.on('accept-call', ({ user }) => {
  console.log(`${user} joined the call`);
});

socket.on('call-participants', ({ participants, callId }) => {
  if (callId !== currentCallId || !isCallActive) return;
  participants.forEach(async userId => {
    if (userId !== username && !peerConnections[userId]) {
      await establishPeerConnection(userId, true);
    }
  });
});

socket.on('offer', async ({ from, offer }) => {
  const pc = await establishPeerConnection(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer, callId: currentCallId });
});

socket.on('answer', async ({ from, answer }) => {
  const pc = peerConnections[from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', ({ from, candidate }) => {
  const pc = peerConnections[from];
  if (pc && candidate) {
    pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

socket.on('end-call', () => {
  endCall();
});

socket.on('connect', () => {
  console.log("Connected to server");
});
