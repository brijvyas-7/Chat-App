
  // --------------------
  // Initialize Socket.IO
  // --------------------
  const socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  });
  console.log("Socket initialized:", socket.id);

  // Temporarily disable service worker during development
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs =>
      regs.forEach(r => r.unregister())
    );
  }

  // --------------------
  // DOM & Audio Elements
  // --------------------
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
  const notificationSound  = new Audio('/sounds/notification.mp3');
  const callSound          = new Audio('/sounds/call.mp3');

  // --------------------
  // State & Config
  // --------------------
  const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true }) || {};
  let replyTo       = null;
  let isMuted       = localStorage.getItem('isMuted') === 'true';
  let lastTypingUpdate = 0;
  const SWIPE_THRESHOLD = 60;

  // WebRTC
  let localStream, remoteStream, peerConnection;
  let isAudioMuted = false, isVideoOff = false;
  let iceCandidatesQueue = [];
  let currentCallId = null, callTimeout = null, isCallActive = false;

  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
  };

  const uuidv4 = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0,
            v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });

  // --------------------
  // Dark Mode
  // --------------------
  function initDarkMode() {
    const isDark = localStorage.getItem('darkMode') === 'true';
    document.body.classList.toggle('dark', isDark);
    updateThemeIcon(isDark);
    updateBackground(isDark);
  }
  function updateThemeIcon(d) {
    const icon = themeBtn.querySelector('i');
    icon.classList.toggle('fa-moon', !d);
    icon.classList.toggle('fa-sun', d);
  }
  function updateBackground(d) {
    const cc = document.querySelector('.chat-container');
    const mc = document.querySelector('.messages-container');
    if (d) {
      cc.style.backgroundColor = 'var(--terminal-bg)';
      mc.style.backgroundColor = 'var(--terminal-bg)';
    } else {
      cc.style.backgroundColor = '';
      mc.style.backgroundColor = '';
    }
  }

  // --------------------
  // Scrolling & Seen
  // --------------------
  function scrollToBottom(force = false) {
    const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 200;
    if (force || nearBottom) {
      chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
    }
    markSeen();
  }
  function markSeen() {
    const seenIds = Array.from(chatMessages.querySelectorAll('.message.you'))
      .map(m => m.id).filter(Boolean);
    if (seenIds.length) {
      socket.emit('markAsSeen', { messageIds: seenIds, room });
    }
  }

  // --------------------
  // Message Rendering
  // --------------------
  function addMessage(msg) {
    if (document.querySelector('.typing-indicator')) {
      document.querySelector('.typing-indicator').remove();
    }
    const div = document.createElement('div');
    const isMe = msg.username === username;
    div.className = `message ${isMe? 'you':'other'}${msg.username==='ChatApp Bot'? ' system':''}`;
    div.id = msg.id;
    let html = '';
    if (msg.replyTo) {
      html += `
        <div class="message-reply">
          <span class="reply-sender">${msg.replyTo.username}</span>
          <span class="reply-text">${msg.replyTo.text}</span>
        </div>`;
    }
    html += `<div class="meta">
      ${isMe? '<span class="prompt-sign">></span>':''}
      <strong>${msg.username}</strong>
      <span class="message-time">${msg.time}</span>
    </div>
    <div class="text">${msg.text}</div>`;
    if (isMe) {
      const seen = msg.seenBy?.length > 0
        ? msg.seenBy.map(u=> u===username? 'You':u).join(', ')
        : '';
      html += `<div class="message-status">
        <span class="seen-icon">${seen? '✓✓':'✓'}</span>
        ${seen? `<span class="seen-users">${seen}</span>`:``}
      </div>`;
    }
    div.innerHTML = html;
    if (!document.body.classList.contains('dark')) {
      setupSwipe(div);
    }
    div.addEventListener('click', () => tryReply(div));
    chatMessages.appendChild(div);
    setTimeout(()=> scrollToBottom(true), 50);
  }

  function setupSwipe(el) {
    let startX=0;
    el.addEventListener('touchstart', e=> startX=e.touches[0].clientX, {passive:true});
    el.addEventListener('touchmove', e=>{
      const dx=e.touches[0].clientX-startX;
      if(dx>0&&dx<100){ e.preventDefault(); el.style.transform=`translateX(${dx}px)`; }
    }, {passive:false});
    el.addEventListener('touchend', e=>{
      const dx=e.changedTouches[0].clientX-startX;
      if(dx>SWIPE_THRESHOLD) tryReply(el);
      el.style.transform='';
    },{passive:true});
  }

  function tryReply(el) {
    if (window.innerWidth<=768) return;
    const user = el.querySelector('.meta strong')?.textContent;
    const txt  = el.querySelector('.text')?.textContent;
    if (user && txt) setupReply(user, el.id, txt);
  }

  function setupReply(user, id, txt) {
    replyTo = { id, username: user, text: txt };
    replyUserElem.textContent = user;
    replyTextElem.textContent = txt.length>30? txt.slice(0,30)+'…': txt;
    replyPreview.classList.remove('d-none');
    msgInput.focus();
    window.navigator.vibrate?.(50);
    setTimeout(()=> document.querySelector('.input-form').scrollIntoView({behavior:'smooth'}),100);
  }

  // --------------------
  // Typing Indicators
  // --------------------
  function showTyping(u) {
    if (document.querySelector('.typing-indicator')) {
      document.querySelector('.typing-indicator').remove();
    }
    const div = document.createElement('div');
    div.className = 'typing-indicator other';
    div.innerHTML = `
      <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
      <span class="typing-text">${u} is typing…</span>`;
    chatMessages.appendChild(div);
    scrollToBottom(true);
  }

  // --------------------
  // UI Toggling Helpers
  // --------------------
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
    // Replace spinner with real video layout
    videoCallContainer.innerHTML = `
      <div class="video-grid">
        <video id="remote-video" autoplay playsinline class="remote-video"></video>
        <video id="local-video"  autoplay playsinline muted  class="local-video"></video>
      </div>
      <div class="video-controls">
        <button id="toggle-audio-btn" class="control-btn audio-btn"><i class="fas fa-microphone"></i></button>
        <button id="end-call-btn"    class="control-btn end-btn">   <i class="fas fa-phone-slash"></i></button>
        <button id="toggle-video-btn"class="control-btn video-btn"><i class="fas fa-video"></i></button>
      </div>`;
    callSound.pause(); callSound.currentTime=0;
    clearTimeout(callTimeout);

    document.getElementById('toggle-audio-btn').onclick = toggleAudio;
    document.getElementById('toggle-video-btn').onclick = toggleVideo;
    document.getElementById('end-call-btn').onclick    = endVideoCall;

    updateMediaButtons();
  }

  function hideCallUI() {
    videoCallContainer.classList.add('d-none');
    callSound.pause(); callSound.currentTime=0;
    clearTimeout(callTimeout);
  }

  function showCallEndedUI(msg) {
    const alertBox = document.createElement('div');
    alertBox.className = 'call-ended-alert';
    alertBox.innerHTML = `
      <div class="alert-content">
        <p>${msg}</p>
        <button id="close-alert-btn" class="btn btn-primary">OK</button>
      </div>`;
    document.body.appendChild(alertBox);
    document.getElementById('close-alert-btn').onclick = ()=>{
      alertBox.remove();
    };
  }

  // --------------------
  // Media Buttons
  // --------------------
  function updateMediaButtons() {
    const au = document.getElementById('toggle-audio-btn');
    const vi = document.getElementById('toggle-video-btn');
    if (au) au.innerHTML = `<i class="fas fa-microphone${isAudioMuted?'-slash':''}"></i>`;
    if (vi) vi.innerHTML = `<i class="fas fa-video${isVideoOff?'-slash':''}"></i>`;
    muteBtn.innerHTML = `<i class="fas fa-bell${isMuted?'-slash':''}"></i>`;
  }
  function toggleAudio() {
    localStream.getAudioTracks().forEach(t => t.enabled = (isAudioMuted = !isAudioMuted)?false:true);
    updateMediaButtons();
  }
  function toggleVideo() {
    localStream.getVideoTracks().forEach(t => t.enabled = (isVideoOff = !isVideoOff)?false:true);
    updateMediaButtons();
  }

  // --------------------
  // Video-Call Logic
  // --------------------
  async function checkMediaPermissions() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
      s.getTracks().forEach(t=>t.stop());
      return true;
    } catch {
      alert('Please allow camera/mic access!');
      return false;
    }
  }

  async function startVideoCall() {
    if (isCallActive) return;
    if (!await checkMediaPermissions()) return;

    isCallActive = true;
    currentCallId = uuidv4();
    peerConnection = new RTCPeerConnection(configuration);

    // get camera + mic
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:1280}, height:{ideal:720}, facingMode:'user' },
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });

    // show spinner UI
    showCallingUI();

    // immediately show your own preview
    showVideoCallUI();
    const newLocal  = document.getElementById('local-video');
    const newRemote = document.getElementById('remote-video');
    newLocal.srcObject = localStream;
    newLocal.play().catch(()=>{});

    // add tracks
    localStream.getTracks().forEach(track=> peerConnection.addTrack(track, localStream) );

    // when remote arrives…
    peerConnection.ontrack = e=>{
      remoteStream = e.streams[0];
      if (remoteStream) {
        newRemote.srcObject = remoteStream;
        newRemote.play().catch(()=>{});
        showVideoCallUI();
      }
    };

    peerConnection.onicecandidate = e=>{
      if (e.candidate) {
        socket.emit('ice-candidate', {
          candidate: e.candidate,
          room, callId: currentCallId
        });
      }
    };

    peerConnection.onconnectionstatechange = ()=>{
      if (peerConnection.connectionState !== 'connected') {
        endVideoCall();
        showCallEndedUI('Call disconnected');
      }
    };

    // create & send offer
    const offer = await peerConnection.createOffer({offerToReceiveAudio:true, offerToReceiveVideo:true});
    await peerConnection.setLocalDescription(offer);
    socket.emit('video-call-initiate', {
      offer, room, callId: currentCallId, caller: username
    });

    // timeout if no answer
    callTimeout = setTimeout(()=>{
      endVideoCall();
      showCallEndedUI('Call not answered');
    }, 30000);
  }

  function endVideoCall() {
    if (localStream)  localStream.getTracks().forEach(t=>t.stop());
    if (remoteStream) remoteStream.getTracks().forEach(t=>t.stop());
    peerConnection?.close();
    hideCallUI();
    socket.emit('end-call', { room, callId: currentCallId });
    isCallActive = false;
    currentCallId = null;
  }

  // handle incoming offer
  async function handleIncomingCall({offer, callId, caller}) {
    if (isCallActive) {
      return socket.emit('reject-call',{room,callId,reason:'busy'});
    }
    if (!confirm(`${caller} is calling. Accept?`)) {
      return socket.emit('reject-call',{room,callId});
    }
    isCallActive = true;
    currentCallId = callId;
    peerConnection = new RTCPeerConnection(configuration);

    // get your own camera
    localStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    showVideoCallUI();
    const newLocal  = document.getElementById('local-video');
    const newRemote = document.getElementById('remote-video');
    newLocal.srcObject = localStream; newLocal.play().catch(()=>{});

    localStream.getTracks().forEach(track=> peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = e=>{
      remoteStream = e.streams[0];
      newRemote.srcObject = remoteStream;
      newRemote.play().catch(()=>{});
    };

    peerConnection.onicecandidate = e=>{
      if (e.candidate) {
        socket.emit('ice-candidate',{ candidate:e.candidate, room, callId });
      }
    };

    peerConnection.onconnectionstatechange = ()=>{
      if (peerConnection.connectionState!=='connected') {
        endVideoCall();
        showCallEndedUI('Call disconnected');
      }
    };

    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('video-answer',{ answer, room, callId });
  }

  function processQueuedCandidates() {
    iceCandidatesQueue.forEach(c=>peerConnection.addIceCandidate(c).catch(console.error));
    iceCandidatesQueue = [];
  }

  // --------------------
  // Socket Events
  // --------------------
  socket.on('connect', ()=> socket.emit('joinRoom',{username,room}));
  socket.on('disconnect', ()=> peerConnection && endVideoCall());

  socket.on('message', msg=>{
    if (msg.username!==username && !isMuted) notificationSound.play().catch(()=>{});
    addMessage(msg);
  });

  socket.on('showTyping', ({username:u})=> u!==username && showTyping(u));
  socket.on('stopTyping', ()=> document.querySelector('.typing-indicator')?.remove());

  socket.on('messagesSeen', updates=>{
    updates.forEach(u=>{
      const m = document.getElementById(u.messageId);
      if (m) {
        const stat = m.querySelector('.message-status');
        const seen = u.seenBy.map(x=> x===username?'You':x).join(', ');
        stat.innerHTML = `<span class="seen-icon">${u.seenBy.length>1?'✓✓':'✓'}</span>
                          <span class="seen-users">${seen}</span>`;
      }
    });
  });

  socket.on('incoming-call', handleIncomingCall);
  socket.on('video-answer', async ({answer,callId})=>{
    if (callId!==currentCallId) return;
    await peerConnection.setRemoteDescription(answer);
    processQueuedCandidates();
  });
  socket.on('ice-candidate', ({candidate,callId})=>{
    if (callId!==currentCallId) return iceCandidatesQueue.push(candidate);
    peerConnection.addIceCandidate(candidate).catch(console.error);
  });
  socket.on('end-call', ()=> endVideoCall());
  socket.on('reject-call', ({reason})=>{
    endVideoCall();
    showCallEndedUI(reason==='busy'?'User busy':'Call rejected');
  });

  // --------------------
  // Form, Buttons & Init
  // --------------------
  document.getElementById('chat-form').onsubmit = e=>{
    e.preventDefault();
    const txt = msgInput.value.trim();
    if (!txt) return;
    socket.emit('chatMessage', {
      text: txt,
      replyTo,
      room
    });
    msgInput.value = '';
    replyTo = null;
    replyPreview.classList.add('d-none');
  };

  cancelReplyBtn.onclick = e=>{
    e.stopPropagation();
    replyTo = null;
    replyPreview.classList.add('d-none');
  };

  msgInput.oninput = ()=>{
    const now = Date.now();
    if (now - lastTypingUpdate > 1000) {
      socket.emit('typing',{room});
      lastTypingUpdate = now;
    }
    clearTimeout(window.stopTypingTimeout);
    window.stopTypingTimeout = setTimeout(()=> socket.emit('stopTyping',{room}), 2000);
  };

  themeBtn.onclick = ()=>{
    const d = !document.body.classList.contains('dark');
    document.body.classList.toggle('dark', d);
    localStorage.setItem('darkMode', d);
    updateThemeIcon(d);
    updateBackground(d);
  };

  muteBtn.onclick = ()=>{
    isMuted = !isMuted;
    localStorage.setItem('isMuted', isMuted);
    updateMediaButtons();
  };

  videoCallBtn.onclick = ()=> startVideoCall();

  window.onbeforeunload = ()=> {
    if (peerConnection) {
      socket.emit('end-call',{room,callId:currentCallId});
      endVideoCall();
    }
  };

  // iOS keyboard fix
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    window.addEventListener('resize', ()=>{
      document.querySelector('header').style.position = 'sticky';
    });
  }

  function init() {
    if (!username || !room) return alert('Missing username or room');
    initDarkMode();
    scrollToBottom(true);
    roomNameElem.textContent = room || 'Global Chat';
  }
  init();
