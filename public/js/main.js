// Complete Chat Application with Video Calling (Full Version)
window.addEventListener('DOMContentLoaded', () => {
  // State Management
  const state = {
    hasJoined: false,
    replyTo: null,
    isMuted: localStorage.getItem('isMuted') === 'true',
    peerConnections: {},
    localStream: null,
    remoteStreams: {},
    currentCallId: null,
    callTimeout: null,
    isCallActive: false,
    iceQueues: {},
    isAudioMuted: false,
    isVideoOff: false,
    currentCallType: null,
    currentFacingMode: 'user',
    lastTypingUpdate: 0,
    touchStartX: 0,
    touchEndX: 0,
    SWIPE_THRESHOLD: 60,
    MAX_RECONNECT_ATTEMPTS: 5,
    reconnectAttempts: 0,
    makingOffer: false,
    ignoreOffer: false,
    typingTimeout: null,
    debugMode: true
  };

  // DOM Elements
  const elements = {
    msgInput: document.getElementById('msg'),
    chatMessages: document.getElementById('chat-messages'),
    replyPreview: document.getElementById('reply-preview'),
    replyUser: document.getElementById('reply-user'),
    replyText: document.getElementById('reply-text'),
    cancelReplyBtn: document.getElementById('cancel-reply'),
    themeBtn: document.getElementById('theme-toggle'),
    muteBtn: document.getElementById('mute-toggle'),
    roomName: document.getElementById('room-name'),
    videoCallBtn: document.getElementById('video-call-btn'),
    audioCallBtn: document.getElementById('audio-call-btn'),
    videoCallContainer: document.getElementById('video-call-container'),
    connectionStatus: document.getElementById('connection-status'),
    chatForm: document.getElementById('chat-form')
  };

  // Debug Logger
  const debug = {
    log: (...args) => state.debugMode && console.log('[DEBUG]', ...args),
    error: (...args) => state.debugMode && console.error('[DEBUG]', ...args),
    warn: (...args) => state.debugMode && console.warn('[DEBUG]', ...args)
  };

  // Media Elements
  const media = {
    notificationSound: new Audio('/sounds/notification.mp3'),
    callSound: new Audio('/sounds/call.mp3')
  };

  // Query Parameters
  const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });

  // Initialize Socket.IO
  const socket = io({
    reconnection: true,
    reconnectionAttempts: state.MAX_RECONNECT_ATTEMPTS,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    timeout: 20000
  });

  // Utility Functions
  const utils = {
    generateId: () => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    },

    initDarkMode: () => {
      const dark = localStorage.getItem('darkMode') === 'true';
      document.body.classList.toggle('dark', dark);
      elements.chatMessages.classList.toggle('dark-bg', dark);
    },

    updateConnectionStatus: (status) => {
      if (!elements.connectionStatus) return;
      elements.connectionStatus.textContent = status.text;
      elements.connectionStatus.className = `connection-status ${status.type}`;
    },

    playNotificationSound: () => {
      if (document.hasUserInteraction) {
        media.notificationSound.play().catch(e => debug.error('Notification sound error:', e));
      } else {
        window.pendingNotifications = window.pendingNotifications || [];
        window.pendingNotifications.push(() => {
          media.notificationSound.play().catch(e => debug.error('Notification sound error:', e));
        });
      }
    }
  };

  // Message Handling
  const messageHandler = {
    addMessage: (msg) => {
      debug.log('Adding message:', msg);
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
          messageHandler.setupReply(u, el.id, t);
        };
      }

      elements.chatMessages.appendChild(el);
      setTimeout(() => {
        elements.chatMessages.scrollTo({ top: elements.chatMessages.scrollHeight, behavior: 'smooth' });
      }, 20);
    },

    setupReply: (u, id, t) => {
      debug.log('Setting up reply to:', u, id, t);
      state.replyTo = { id, username: u, text: t };
      elements.replyUser.textContent = u;
      elements.replyText.textContent = t.length > 30 ? t.substr(0, 30) + '...' : t;
      elements.replyPreview.classList.remove('d-none');
      elements.msgInput.focus();
    },

    showTypingIndicator: (u) => {
      debug.log('Showing typing indicator for:', u);
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
        elements.chatMessages.appendChild(d);
        elements.chatMessages.scrollTo({ top: elements.chatMessages.scrollHeight, behavior: 'smooth' });
      }
    },

    handleTyping: () => {
      const now = Date.now();
      if (now - state.lastTypingUpdate > 1000) {
        socket.emit('typing', { username, room });
        state.lastTypingUpdate = now;
      }
      
      clearTimeout(state.typingTimeout);
      state.typingTimeout = setTimeout(() => {
        socket.emit('stopTyping', { username, room });
      }, 2000);
    }
  };

  // WebRTC Functions
  const webrtc = {
    createPeerConnection: (userId) => {
      debug.log(`Creating peer connection for ${userId}`);
      try {
        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
          ],
          iceTransportPolicy: 'all',
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require'
        });

        pc.onconnectionstatechange = () => {
          debug.log(`${userId} connection state: ${pc.connectionState}`);
          if (pc.connectionState === 'failed') {
            webrtc.removePeerConnection(userId);
          }
        };

        pc.oniceconnectionstatechange = () => {
          debug.log(`${userId} ICE state: ${pc.iceConnectionState}`);
          if (['disconnected', 'failed'].includes(pc.iceConnectionState)) {
            webrtc.removePeerConnection(userId);
          }
        };

        pc.onsignalingstatechange = () => {
          debug.log(`${userId} signaling state: ${pc.signalingState}`);
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            debug.log(`Sending ICE candidate to ${userId}`);
            socket.emit('ice-candidate', {
              candidate: event.candidate,
              room,
              callId: state.currentCallId,
              targetUser: userId
            });
          }
        };

        pc.ontrack = (event) => {
          debug.log(`Track event from ${userId}`);
          if (event.streams && event.streams.length > 0) {
            const stream = event.streams.find(s => s.getVideoTracks().length > 0) || event.streams[0];
            webrtc.attachRemoteStream(userId, stream);
          }
        };

        return pc;
      } catch (error) {
        debug.error(`Failed to create peer connection:`, error);
        return null;
      }
    },

    attachRemoteStream: (userId, stream) => {
      debug.log(`Attaching remote stream for ${userId}`);
      if (!stream) return;

      state.remoteStreams[userId] = stream;

      if (state.currentCallType === 'video' && stream.getVideoTracks().length > 0) {
        const existing = document.getElementById(`remote-container-${userId}`);
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.className = 'video-container';
        container.id = `remote-container-${userId}`;

        const video = document.createElement('video');
        video.id = `remote-video-${userId}`;
        video.autoplay = true;
        video.playsInline = true;

        const label = document.createElement('div');
        label.className = 'video-user-label';
        label.textContent = userId;

        container.appendChild(video);
        container.appendChild(label);
        document.getElementById('video-grid').appendChild(container);

        video.srcObject = stream;
        video.onloadedmetadata = () => {
          video.play().catch(e => {
            debug.error('Video play failed:', e);
            webrtc.showVideoPlayButton(container, video);
          });
        };
      } else {
        webrtc.addAudioElement(userId);
      }
    },

    establishPeerConnection: async (userId, isInitiator = false) => {
      debug.log(`Establishing connection with ${userId}, initiator: ${isInitiator}`);
      if (!state.isCallActive || state.peerConnections[userId]) return;

      const pc = webrtc.createPeerConnection(userId);
      if (!pc) return;

      state.peerConnections[userId] = pc;

      if (state.localStream) {
        debug.log('Adding local tracks');
        state.localStream.getTracks().forEach(track => {
          try {
            pc.addTrack(track, state.localStream);
          } catch (err) {
            debug.error('Error adding track:', err);
          }
        });
      }

      const queue = (state.iceQueues[state.currentCallId] || {})[userId] || [];
      for (const c of queue) {
        try {
          await pc.addIceCandidate(c);
        } catch (err) {
          debug.error('Error adding ICE candidate:', err);
        }
      }
      if (state.iceQueues[state.currentCallId]) state.iceQueues[state.currentCallId][userId] = [];

      if (isInitiator) {
        try {
          state.makingOffer = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          
          socket.emit('offer', {
            offer: pc.localDescription,
            room,
            callId: state.currentCallId,
            targetUser: userId
          });
        } catch (err) {
          debug.error('Error creating offer:', err);
        } finally {
          state.makingOffer = false;
        }
      }
    },

    addVideoElement: (type, userId, stream, isLocal = false) => {
      const g = document.getElementById('video-grid');
      if (!g) return;

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

      if (isLocal && state.currentCallType === 'video') {
        video.style.transform = 'scaleX(-1)';
      }

      const label = document.createElement('div');
      label.className = 'video-user-label';
      label.textContent = userId === username ? 'You' : userId;

      container.appendChild(video);
      container.appendChild(label);
      g.appendChild(container);

      if (stream.active) {
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          video.play().catch(e => {
            debug.error('Video play failed:', e);
            webrtc.showVideoPlayButton(container, video);
          });
        };
      }
    },

    addAudioElement: (userId) => {
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
    },

    showVideoPlayButton: (container, video) => {
      const existingBtn = container.querySelector('.video-play-btn');
      if (existingBtn) return;

      const playBtn = document.createElement('button');
      playBtn.className = 'video-play-btn';
      playBtn.innerHTML = '<i class="fas fa-play"></i>';
      playBtn.onclick = () => {
        video.play()
          .then(() => playBtn.remove())
          .catch(e => debug.error('Still cannot play:', e));
      };
      container.appendChild(playBtn);
    },

    removePeerConnection: (userId) => {
      debug.log(`Removing peer connection for ${userId}`);
      if (state.peerConnections[userId]) {
        try {
          // Stop all tracks before closing
          const pc = state.peerConnections[userId];
          pc.getSenders().forEach(sender => {
            if (sender.track) sender.track.stop();
          });
          pc.close();
        } catch (err) {
          debug.error('Error closing peer connection:', err);
        }
        delete state.peerConnections[userId];
      }

      const vc = document.getElementById(`remote-container-${userId}`);
      if (vc) vc.remove();

      const ac = document.getElementById(`audio-container-${userId}`);
      if (ac) ac.remove();

      delete state.remoteStreams[userId];
    }
  };

  // Call Management
  const callManager = {
    showCallingUI: (t) => {
      elements.videoCallContainer.innerHTML = `
        <div class="calling-ui">
          <div class="calling-spinner"></div>
          <div class="calling-text">Calling ${t === 'audio' ? '(Audio)' : '(Video)'}...</div>
          <button id="cancel-call-btn" class="btn btn-danger">
            <i class="fas fa-phone-slash"></i> Cancel
          </button>
        </div>
      `;
      elements.videoCallContainer.classList.remove('d-none');
      document.getElementById('cancel-call-btn').onclick = callManager.endCall;

      media.callSound.loop = true;
      media.callSound.play().catch(() => {
        const soundBtn = document.createElement('button');
        soundBtn.className = 'sound-permission-btn';
        soundBtn.innerHTML = '<i class="fas fa-volume-up"></i> Click to enable call sounds';
        soundBtn.onclick = () => {
          media.callSound.play().then(() => soundBtn.remove()).catch(console.error);
        };
        elements.videoCallContainer.querySelector('.calling-ui').appendChild(soundBtn);
      });
    },

    showCallUI: (t) => {
      media.callSound.pause();
      clearTimeout(state.callTimeout);

      let controls = `
        <button id="toggle-audio-btn" class="control-btn audio-btn">
          <i class="fas fa-microphone${state.isAudioMuted ? '-slash' : ''}"></i>
        </button>
        <button id="end-call-btn" class="control-btn end-btn">
          <i class="fas fa-phone-slash"></i>
        </button>
      `;

      if (t === 'video') {
        controls += `
          <button id="toggle-video-btn" class="control-btn video-btn">
            <i class="fas fa-video${state.isVideoOff ? '-slash' : ''}"></i>
          </button>
          <button id="flip-camera-btn" class="control-btn flip-btn">
            <i class="fas fa-camera-retro"></i>
          </button>
        `;
      }

      elements.videoCallContainer.innerHTML = `
        <div class="video-call-active">
          <div id="video-grid" class="video-grid"></div>
          <div class="video-controls">${controls}</div>
        </div>
      `;

      elements.videoCallContainer.classList.remove('d-none');
      document.getElementById('toggle-audio-btn').onclick = callManager.toggleAudio;
      document.getElementById('end-call-btn').onclick = callManager.endCall;

      if (t === 'video') {
        document.getElementById('toggle-video-btn').onclick = callManager.toggleVideo;
        document.getElementById('flip-camera-btn').onclick = callManager.flipCamera;
        webrtc.addVideoElement('local', username, state.localStream, true);
      }
    },

    hideCallUI: () => {
      elements.videoCallContainer.classList.add('d-none');
      media.callSound.pause();
      clearTimeout(state.callTimeout);
    },

    showCallEndedUI: (m) => {
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
    },

    startCall: async (t) => {
      if (state.isCallActive) return;

      try {
        // Test permissions first
        const testStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: t === 'video' ? {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          } : false
        });
        testStream.getTracks().forEach(track => track.stop());
      } catch (err) {
        return alert(`Please allow ${t === 'video' ? 'camera and microphone' : 'microphone'} access.`);
      }

      state.isCallActive = true;
      state.currentCallType = t;
      state.currentCallId = utils.generateId();
      state.iceQueues[state.currentCallId] = {};

      callManager.showCallingUI(t);

      try {
        state.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: t === 'video' ? {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          } : false
        });

        debug.log('Local stream tracks:', state.localStream.getTracks());
        callManager.showCallUI(t);
        
        socket.emit('call-initiate', {
          room,
          callId: state.currentCallId,
          callType: t,
          caller: username
        });

        state.callTimeout = setTimeout(() => {
          if (!Object.keys(state.peerConnections).length) {
            callManager.endCall();
            callManager.showCallEndedUI('No one answered');
          }
        }, 45000);
      } catch (err) {
        debug.error('Call start failed:', err);
        callManager.endCall();
        callManager.showCallEndedUI('Call failed to start: ' + err.message);
      }
    },

    handleIncomingCall: async ({ callType, callId, caller }) => {
      if (state.isCallActive) {
        socket.emit('reject-call', { room, callId, reason: 'busy' });
        return;
      }

      const ok = confirm(`${caller} is calling (${callType}). Accept?`);
      if (!ok) {
        socket.emit('reject-call', { room, callId });
        return;
      }

      state.isCallActive = true;
      state.currentCallType = callType;
      state.currentCallId = callId;
      state.iceQueues[callId] = {};

      try {
        state.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: callType === 'video' ? {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          } : false
        });

        callManager.showCallUI(callType);
        socket.emit('accept-call', { room, callId });
        socket.emit('get-call-participants', { room, callId });
      } catch (e) {
        debug.error('Media access failed:', e);
        callManager.endCall();
        callManager.showCallEndedUI('Failed to access media devices');
      }
    },

    endCall: () => {
      debug.log('Ending call and cleaning up resources');
      Object.keys(state.peerConnections).forEach(webrtc.removePeerConnection);

      if (state.localStream) {
        debug.log('Stopping local stream tracks');
        state.localStream.getTracks().forEach(t => {
          t.stop();
          debug.log(`Stopped ${t.kind} track`);
        });
        state.localStream = null;
      }

      state.isCallActive = false;
      state.currentCallId = null;
      state.currentCallType = null;
      clearTimeout(state.callTimeout);
      callManager.hideCallUI();

      if (state.currentCallId) {
        socket.emit('end-call', { room, callId: state.currentCallId });
      }
    },

    toggleAudio: () => {
      state.isAudioMuted = !state.isAudioMuted;
      if (state.localStream) {
        state.localStream.getAudioTracks().forEach(t => t.enabled = !state.isAudioMuted);
      }
      callManager.updateMediaButtons();
      socket.emit('mute-state', {
        room,
        callId: state.currentCallId,
        isAudioMuted: state.isAudioMuted,
        userId: username
      });
    },

    toggleVideo: () => {
      state.isVideoOff = !state.isVideoOff;
      if (state.localStream) {
        state.localStream.getVideoTracks().forEach(t => t.enabled = !state.isVideoOff);
      }
      callManager.updateMediaButtons();
      socket.emit('video-state', {
        room,
        callId: state.currentCallId,
        isVideoOff: state.isVideoOff,
        userId: username
      });
    },

    flipCamera: async () => {
      if (!state.localStream || state.currentCallType !== 'video') return;

      try {
        state.localStream.getVideoTracks().forEach(t => t.stop());
        state.currentFacingMode = state.currentFacingMode === 'user' ? 'environment' : 'user';

        const ns = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {
            facingMode: state.currentFacingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });

        state.localStream.getTracks().forEach(t => state.localStream.removeTrack(t));
        ns.getTracks().forEach(t => state.localStream.addTrack(t));

        Object.values(state.peerConnections).forEach(pc => {
          const s = pc.getSenders().find(x => x.track?.kind === 'video');
          if (s) s.replaceTrack(state.localStream.getVideoTracks()[0]);
        });

        const lv = document.getElementById(`local-video-${username}`);
        if (lv) lv.srcObject = state.localStream;
      } catch (e) {
        debug.error('Camera flip failed:', e);
      }
    },

    updateMediaButtons: () => {
      const a = document.getElementById('toggle-audio-btn');
      const v = document.getElementById('toggle-video-btn');

      if (a) {
        a.innerHTML = `<i class="fas fa-microphone${state.isAudioMuted ? '-slash' : ''}"></i>`;
        a.title = state.isAudioMuted ? 'Unmute' : 'Mute';
      }

      if (v) {
        v.innerHTML = `<i class="fas fa-video${state.isVideoOff ? '-slash' : ''}"></i>`;
        v.title = state.isVideoOff ? 'Enable video' : 'Disable video';
      }
    }
  };

  // Event Listeners
  const setupEventListeners = () => {
    elements.cancelReplyBtn.addEventListener('click', e => {
      e.stopPropagation();
      state.replyTo = null;
      elements.replyPreview.classList.add('d-none');
    });

    // Enhanced swipe-to-reply with debugging
    elements.chatMessages.addEventListener('touchstart', e => {
      state.touchStartX = e.changedTouches[0].screenX;
      debug.log('Touch started at:', state.touchStartX);
    }, { passive: true });

    elements.chatMessages.addEventListener('touchend', e => {
      state.touchEndX = e.changedTouches[0].screenX;
      const diffX = state.touchStartX - state.touchEndX;
      debug.log(`Touch ended at: ${state.touchEndX}, diff: ${diffX}`);

      if (Math.abs(diffX) > state.SWIPE_THRESHOLD) {
        const messageElement = document.elementFromPoint(
          e.changedTouches[0].clientX,
          e.changedTouches[0].clientY
        );

        if (messageElement && messageElement.classList.contains('message')) {
          const u = messageElement.querySelector('.meta strong').textContent;
          const t = messageElement.querySelector('.text').textContent;
          const id = messageElement.id;
          debug.log(`Swiped to reply to message ${id} from ${u}`);
          messageHandler.setupReply(u, id, t);
        }
      }
    }, { passive: true });

    // Typing indicator
    elements.msgInput.addEventListener('input', () => {
      messageHandler.handleTyping();
    });

    elements.chatForm.addEventListener('submit', e => {
      e.preventDefault();
      const txt = elements.msgInput.value.trim();
      if (!txt) return;

      debug.log('Sending message:', txt);
      socket.emit('chatMessage', { 
        text: txt, 
        replyTo: state.replyTo, 
        room 
      });
      
      elements.msgInput.value = '';
      state.replyTo = null;
      elements.replyPreview.classList.add('d-none');
    });

    elements.themeBtn.addEventListener('click', () => {
      const dark = !document.body.classList.toggle('dark');
      localStorage.setItem('darkMode', dark);
      elements.chatMessages.classList.toggle('dark-bg', dark);
    });

    elements.muteBtn.addEventListener('click', () => {
      state.isMuted = !state.isMuted;
      localStorage.setItem('isMuted', state.isMuted);
      elements.muteBtn.innerHTML = state.isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';
      elements.muteBtn.title = state.isMuted ? 'Unmute notifications' : 'Mute notifications';
    });

    elements.videoCallBtn.addEventListener('click', () => callManager.startCall('video'));
    elements.audioCallBtn.addEventListener('click', () => callManager.startCall('audio'));

    window.addEventListener('beforeunload', () => {
      if (state.isCallActive) {
        socket.emit('end-call', { room, callId: state.currentCallId });
      }
    });

    document.addEventListener('click', () => {
      document.hasUserInteraction = true;
      if (window.pendingNotifications) {
        window.pendingNotifications.forEach(fn => fn());
        window.pendingNotifications = [];
      }
    }, { once: true });
  };

  // Socket.IO Handlers
  const setupSocketHandlers = () => {
    socket.on('connect', () => {
      state.reconnectAttempts = 0;
      utils.updateConnectionStatus({ text: 'Connected', type: 'connected' });
      if (!state.hasJoined) {
        socket.emit('joinRoom', { username, room });
        state.hasJoined = true;
      }
    });

    socket.on('disconnect', (reason) => {
      utils.updateConnectionStatus({ text: 'Disconnected', type: 'disconnected' });
      debug.log('Disconnected:', reason);
      if (reason === 'io server disconnect') {
        setTimeout(() => socket.connect(), 1000);
      }
    });

    socket.on('reconnect_attempt', (attempt) => {
      state.reconnectAttempts = attempt;
      utils.updateConnectionStatus({
        text: `Reconnecting (${attempt}/${state.MAX_RECONNECT_ATTEMPTS})...`,
        type: 'reconnecting'
      });
    });

    socket.on('reconnect_failed', () => {
      utils.updateConnectionStatus({
        text: 'Failed to reconnect. Please refresh.',
        type: 'error'
      });
    });

    socket.on('connect_error', (err) => {
      debug.error('Connection error:', err);
      utils.updateConnectionStatus({
        text: 'Connection error',
        type: 'error'
      });
    });

    socket.on('message', msg => {
      debug.log('Received message:', msg);
      if (msg.username !== username && !state.isMuted) {
        utils.playNotificationSound();
      }
      messageHandler.addMessage(msg);
    });

    socket.on('typing', ({ username: u }) => {
      debug.log(`${u} is typing`);
      if (u !== username) messageHandler.showTypingIndicator(u);
    });

    socket.on('stopTyping', () => {
      debug.log('Typing stopped');
      document.querySelectorAll('.typing-indicator').forEach(el => el.remove());
    });

    socket.on('incoming-call', callManager.handleIncomingCall);

    socket.on('offer', async ({ offer, userId, callId }) => {
      debug.log(`Received offer from ${userId}`);
      if (callId !== state.currentCallId || !state.isCallActive) return;

      const pc = state.peerConnections[userId] || await webrtc.establishPeerConnection(userId);
      
      try {
        const offerCollision = (offer.type === 'offer') && 
          (state.makingOffer || pc.signalingState !== 'stable');
        
        state.ignoreOffer = !state.isCallActive && offerCollision;
        if (state.ignoreOffer) return;

        await pc.setRemoteDescription(offer);
        if (offer.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          socket.emit('answer', {
            answer: pc.localDescription,
            room,
            callId,
            targetUser: userId
          });
        }
      } catch (err) {
        debug.error('Offer handling failed:', err);
      }
    });

    socket.on('answer', async ({ answer, userId, callId }) => {
      debug.log(`Received answer from ${userId}`);
      if (callId !== state.currentCallId) return;
      const pc = state.peerConnections[userId];
      if (!pc) return;

      try {
        await pc.setRemoteDescription(answer);
      } catch (err) {
        debug.error('Answer handling failed:', err);
      }
    });

    socket.on('ice-candidate', ({ candidate, userId, callId }) => {
      debug.log(`Received ICE candidate from ${userId}`);
      if (!state.peerConnections[userId]) {
        state.iceQueues[callId] = state.iceQueues[callId] || {};
        state.iceQueues[callId][userId] = state.iceQueues[callId][userId] || [];
        state.iceQueues[callId][userId].push(candidate);
      } else {
        state.peerConnections[userId].addIceCandidate(candidate).catch(err => {
          debug.error('Error adding ICE candidate:', err);
        });
      }
    });

    socket.on('call-participants', ({ participants, callId }) => {
      debug.log('Call participants:', participants);
      if (callId !== state.currentCallId) return;

      participants.forEach(uid => {
        if (uid !== username && !state.peerConnections[uid]) {
          const init = participants.indexOf(username) < participants.indexOf(uid);
          webrtc.establishPeerConnection(uid, init);
        }
      });
    });

    socket.on('accept-call', async ({ userId, callId }) => {
      debug.log(`${userId} accepted call`);
      if (callId !== state.currentCallId || !state.isCallActive) return;
      await webrtc.establishPeerConnection(userId, true);
    });

    socket.on('end-call', () => {
      debug.log('Call ended by remote peer');
      callManager.endCall();
      callManager.showCallEndedUI('Call ended');
    });

    socket.on('reject-call', ({ reason }) => {
      debug.log(`Call rejected: ${reason}`);
      callManager.endCall();
      callManager.showCallEndedUI(reason === 'busy' ? 'User busy' : 'Call rejected');
    });

    socket.on('user-left-call', ({ userId }) => {
      debug.log(`${userId} left the call`);
      webrtc.removePeerConnection(userId);
    });

    socket.on('mute-state', ({ userId, isAudioMuted }) => {
      debug.log(`User ${userId} ${isAudioMuted ? 'muted' : 'unmuted'} audio`);
    });

    socket.on('video-state', ({ userId, isVideoOff }) => {
      debug.log(`User ${userId} ${isVideoOff ? 'disabled' : 'enabled'} video`);
    });
  };

  // Initialize Application
  const init = () => {
    if (!username || !room) {
      alert('Missing username or room!');
      window.location.href = '/';
      return;
    }

    // Add debug commands
    window.debugWebRTC = () => {
      console.group('WebRTC State');
      console.log('Current Call ID:', state.currentCallId);
      console.log('Call Active:', state.isCallActive);
      console.log('Call Type:', state.currentCallType);
      console.log('Local Stream:', state.localStream);
      console.log('Peer Connections:', state.peerConnections);
      console.log('Remote Streams:', state.remoteStreams);
      console.groupEnd();
    };

    debug.log('Initializing application...');
    utils.initDarkMode();
    elements.roomName.textContent = room;
    elements.muteBtn.innerHTML = state.isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';
    elements.muteBtn.title = state.isMuted ? 'Unmute notifications' : 'Mute notifications';

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
      .connection-status {
        position: fixed;
        bottom: 10px;
        right: 10px;
        padding: 5px 10px;
        border-radius: 4px;
        font-size: 12px;
        z-index: 1000;
      }
      .connection-status.connected {
        background: #4CAF50;
        color: white;
      }
      .connection-status.disconnected {
        background: #f44336;
        color: white;
      }
      .connection-status.reconnecting {
        background: #FFC107;
        color: black;
      }
      .connection-status.error {
        background: #f44336;
        color: white;
      }
      .call-ended-alert {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 2000;
      }
      .alert-content {
        background: white;
        padding: 20px;
        border-radius: 8px;
        max-width: 80%;
        text-align: center;
      }
      .dark .alert-content {
        background: #333;
        color: white;
      }
    `;
    document.head.appendChild(style);

    setupEventListeners();
    setupSocketHandlers();
    debug.log('Application initialization complete');
  };

  init();
});