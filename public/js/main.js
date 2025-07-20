// Complete Chat Application with Video Calling (Fixed Version)
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
    SWIPE_THRESHOLD: 60,
    MAX_RECONNECT_ATTEMPTS: 5,
    reconnectAttempts: 0,
    makingOffer: false,
    ignoreOffer: false,
    typingTimeout: null,
    debugMode: true,
    swipeState: {
      active: false,
      startX: 0,
      currentX: 0,
      target: null
    }
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
    generateId: () => crypto.randomUUID(),

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
    },

    getCurrentTime: () => {
      const now = new Date();
      let hours = now.getHours();
      const minutes = now.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'pm' : 'am';
      hours = hours % 12;
      hours = hours ? hours : 12;
      return `${hours}:${minutes} ${ampm}`;
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
      document.querySelectorAll('.typing-indicator').forEach(el => el.remove());

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
      
      // Add after last message
      const messages = elements.chatMessages.querySelectorAll('.message');
      if (messages.length > 0) {
        elements.chatMessages.insertBefore(d, messages[messages.length - 1].nextSibling);
      } else {
        elements.chatMessages.appendChild(d);
      }
      
      elements.chatMessages.scrollTo({ top: elements.chatMessages.scrollHeight, behavior: 'smooth' });
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
          if (pc.iceConnectionState === 'failed') {
            debug.log('ICE connection failed, attempting restart...');
            webrtc.restartIce(userId);
          } else if (['disconnected', 'failed'].includes(pc.iceConnectionState)) {
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
            const stream = event.streams[0];
            state.remoteStreams[userId] = stream;
            webrtc.attachRemoteStream(userId, stream);
          }
        };

        pc.onnegotiationneeded = async () => {
          debug.log(`Negotiation needed for ${userId}`);
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
            debug.error('Error during negotiation:', err);
          } finally {
            state.makingOffer = false;
          }
        };

        return pc;
      } catch (error) {
        debug.error(`Failed to create peer connection:`, error);
        return null;
      }
    },

    restartIce: async (userId) => {
      const pc = state.peerConnections[userId];
      if (!pc) return;

      try {
        debug.log(`Restarting ICE for ${userId}`);
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        socket.emit('offer', {
          offer: pc.localDescription,
          room,
          callId: state.currentCallId,
          targetUser: userId
        });
      } catch (err) {
        debug.error('Error restarting ICE:', err);
      }
    },

    attachRemoteStream: (userId, stream) => {
      debug.log(`Attaching remote stream for ${userId}`);
      if (!stream) return;

      // Remove existing video element if it exists
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
    },

    establishPeerConnection: async (userId, isInitiator = false) => {
      debug.log(`Establishing connection with ${userId}, initiator: ${isInitiator}`);
      if (state.peerConnections[userId]) {
        debug.log(`Peer connection already exists for ${userId}`);
        return;
      }

      const pc = webrtc.createPeerConnection(userId);
      if (!pc) return;

      state.peerConnections[userId] = pc;

      // Add local tracks if available
      if (state.localStream) {
        debug.log('Adding local tracks to peer connection');
        state.localStream.getTracks().forEach(track => {
          try {
            pc.addTrack(track, state.localStream);
          } catch (err) {
            debug.error('Error adding track:', err);
          }
        });
      }

      // Process any queued ICE candidates
      const queue = (state.iceQueues[state.currentCallId] || {})[userId] || [];
      debug.log(`Processing ${queue.length} queued ICE candidates`);
      for (const candidate of queue) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          debug.error('Error adding ICE candidate:', err);
        }
      }
      delete state.iceQueues[state.currentCallId]?.[userId];

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

      // Mirror only front camera
      if (isLocal) {
        video.style.transform = state.currentFacingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
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

      // Remove UI elements
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
          if (Object.keys(state.peerConnections).length === 0) {
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

        state.callTimeout = setTimeout(() => {
          if (Object.keys(state.peerConnections).length === 0) {
            callManager.endCall();
            callManager.showCallEndedUI('Failed to establish connection');
          }
        }, 30000);
      } catch (e) {
        debug.error('Media access failed:', e);
        callManager.endCall();
        callManager.showCallEndedUI('Failed to access media devices');
      }
    },

    endCall: () => {
      if (!state.isCallActive) return;
      
      debug.log('Ending call and cleaning up resources');
      clearTimeout(state.callTimeout);
      
      // Clean up peer connections
      Object.keys(state.peerConnections).forEach(userId => {
        const pc = state.peerConnections[userId];
        if (pc) {
          pc.getSenders().forEach(sender => {
            if (sender.track) sender.track.stop();
          });
          pc.close();
        }
        webrtc.removePeerConnection(userId);
      });
      
      // Clean up local stream
      if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
      }

      state.isCallActive = false;
      state.currentCallId = null;
      state.currentCallType = null;
      callManager.hideCallUI();
      
      // Notify server only if we're the ones ending the call
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

        // Update mirror effect based on camera type
        const lv = document.getElementById(`local-video-${username}`);
        if (lv) {
          lv.srcObject = state.localStream;
          lv.style.transform = state.currentFacingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
        }

        Object.values(state.peerConnections).forEach(pc => {
          const s = pc.getSenders().find(x => x.track?.kind === 'video');
          if (s) s.replaceTrack(state.localStream.getVideoTracks()[0]);
        });

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

    // Improved swipe-to-reply
    elements.chatMessages.addEventListener('touchstart', e => {
      if (e.target.closest('.message')) {
        state.swipeState.active = true;
        state.swipeState.startX = e.touches[0].clientX;
        state.swipeState.currentX = state.swipeState.startX;
        state.swipeState.target = e.target.closest('.message');
        state.swipeState.target.style.transition = 'none';
      }
    }, { passive: true });

    elements.chatMessages.addEventListener('touchmove', e => {
      if (state.swipeState.active) {
        e.preventDefault();
        const deltaX = e.touches[0].clientX - state.swipeState.startX;
        if (Math.abs(deltaX) > 10) {
          state.swipeState.currentX = e.touches[0].clientX;
          const translateX = Math.min(0, Math.max(-100, deltaX));
          state.swipeState.target.style.transform = `translateX(${translateX}px)`;
        }
      }
    }, { passive: false });

    elements.chatMessages.addEventListener('touchend', e => {
      if (state.swipeState.active) {
        state.swipeState.active = false;
        const deltaX = state.swipeState.currentX - state.swipeState.startX;
        
        state.swipeState.target.style.transition = 'transform 0.3s ease';
        state.swipeState.target.style.transform = '';
        
        if (Math.abs(deltaX) > state.SWIPE_THRESHOLD) {
          const u = state.swipeState.target.querySelector('.meta strong').textContent;
          const t = state.swipeState.target.querySelector('.text').textContent;
          const id = state.swipeState.target.id;
          messageHandler.setupReply(u, id, t);
          
          // Add visual feedback
          const feedback = document.createElement('div');
          feedback.className = 'swipe-feedback';
          feedback.textContent = 'Replying...';
          state.swipeState.target.appendChild(feedback);
          setTimeout(() => feedback.remove(), 1000);
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
        replyTo: state.replyTo ? {
          id: state.replyTo.id,
          username: state.replyTo.username,
          text: state.replyTo.text
        } : null,
        room,
        time: utils.getCurrentTime()
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

    socket.on('ice-candidate', async ({ candidate, userId, callId }) => {
      debug.log(`Received ICE candidate from ${userId}`);
      
      try {
        const pc = state.peerConnections[userId];
        if (pc) {
          await pc.addIceCandidate(candidate);
          debug.log('Successfully added ICE candidate');
        } else {
          // Queue candidate if peer connection doesn't exist yet
          state.iceQueues[callId] = state.iceQueues[callId] || {};
          state.iceQueues[callId][userId] = state.iceQueues[callId][userId] || [];
          state.iceQueues[callId][userId].push(candidate);
          debug.log(`Queued ICE candidate for ${userId}`);
        }
      } catch (err) {
        debug.error('Error adding ICE candidate:', err);
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
        height: calc(100% - 80px);
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
      .local-video-container video {
        transform: scaleX(-1);
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
        margin-top: 5px;
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
        border-radius: 50%;
        width: 50px;
        height: 50px;
        font-size: 20px;
        cursor: pointer;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .sound-permission-btn {
        position: relative;
        top: auto;
        left: auto;
        transform: none;
        margin-top: 10px;
        border-radius: 4px;
        padding: 8px 12px;
        width: auto;
        height: auto;
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
      .message {
        transition: transform 0.3s ease;
        touch-action: pan-y;
      }
      .swipe-feedback {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        background: rgba(0,0,0,0.7);
        color: white;
        padding: 5px 10px;
        border-radius: 15px;
        font-size: 12px;
        animation: fadeIn 0.3s ease;
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-50%) translateX(20px); }
        to { opacity: 1; transform: translateY(-50%) translateX(0); }
      }
      .video-controls {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        display: flex;
        justify-content: center;
        gap: 15px;
        padding: 15px;
        background: rgba(0,0,0,0.5);
        z-index: 1001;
      }
      .video-controls button {
        border: none;
        border-radius: 50%;
        width: 60px;
        height: 60px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
      }
      .video-controls button:hover {
        transform: scale(1.1);
      }
      .video-controls button i {
        font-size: 20px;
      }
      .control-btn.end-btn {
        background-color: #f44336;
        color: white;
      }
      .control-btn.audio-btn {
        background-color: #2196F3;
        color: white;
      }
      .control-btn.video-btn {
        background-color: #4CAF50;
        color: white;
      }
      .control-btn.flip-btn {
        background-color: #FFC107;
        color: black;
      }
      @media (max-width: 768px) {
        .video-grid {
          grid-template-columns: 1fr;
        }
        .video-container {
          aspect-ratio: 16/9;
        }
        .video-controls button {
          width: 50px;
          height: 50px;
        }
        .video-controls button i {
          font-size: 18px;
        }
      }
    `;
    document.head.appendChild(style);

    setupEventListeners();
    setupSocketHandlers();
    debug.log('Application initialization complete');
  };

  init();
});