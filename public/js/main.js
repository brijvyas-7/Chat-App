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
      target: null,
      isYou: false
    },
    callParticipants: [],
    isCallInitiator: false,
    pendingSignaling: {},
    polite: true
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
    chatForm: document.getElementById('chat-form'),
    header: document.getElementById('room-header'),
    chatContainer: document.querySelector('.chat-container')
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
    },

    verifyUserPresence: (userId, callback) => {
      socket.emit('check-user-presence', { room, userId }, (response) => {
        callback(response.isPresent);
      });
    },

    scrollToMessage: (id) => {
      const msg = document.getElementById(id);
      if (msg) {
        msg.classList.add('highlight');
        setTimeout(() => msg.classList.remove('highlight'), 2000);
        msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      
      // Enhanced reply display (like WhatsApp)
      if (msg.replyTo && msg.replyTo.id && msg.replyTo.username && msg.replyTo.text && !isSys) {
        const originalText = msg.replyTo.text.length > 30 
          ? msg.replyTo.text.substring(0, 30) + '...' 
          : msg.replyTo.text;
        
        html += `<div class="message-reply-container" onclick="utils.scrollToMessage('${msg.replyTo.id}')">
                  <span class="reply-sender">${msg.replyTo.username === username ? 'You' : msg.replyTo.username}</span>
                  <span class="reply-text">${originalText}</span>
                </div>`;
      }

      html += `<div class="meta">
            <strong>${msg.username}</strong>
            <span class="message-time">${msg.time}</span>
          </div>
          <div class="text">${msg.text}</div>`;

      if (isMe && !isSys) {
        html += `<div class="message-status">
              <span class="seen-icon">✓</span>
            </div>`;
      }

      el.innerHTML = html;
      elements.chatMessages.appendChild(el);

      setTimeout(() => {
        elements.chatMessages.scrollTo({ top: elements.chatMessages.scrollHeight, behavior: 'smooth' });
      }, 20);
    },

    setupReply: (u, id, t) => {
      debug.log('Setting up reply to:', { username: u, id, text: t });
      state.replyTo = { id, username: u, text: t };
      elements.replyUser.textContent = u === username ? 'You' : u;
      elements.replyText.textContent = t.length > 30 ? t.substr(0, 30) + '...' : t;
      elements.replyPreview.classList.remove('d-none');
      elements.replyPreview.style.display = 'flex';
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
            { urls: 'stun:stun2.l.google.com:19302' },
            {
              urls: 'turn:turn.example.com:3478',
              username: 'username',
              credential: 'password'
            }
          ],
          iceTransportPolicy: 'all',
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require'
        });

        pc.onconnectionstatechange = () => {
          debug.log(`${userId} connection state: ${pc.connectionState}`);
          if (['failed', 'disconnected'].includes(pc.connectionState)) {
            webrtc.removePeerConnection(userId);
            if (Object.keys(state.peerConnections).length === 0 && state.isCallActive) {
              callManager.endCall();
              callManager.showCallEndedUI('Connection failed');
            }
          }
        };

        pc.oniceconnectionstatechange = () => {
          debug.log(`${userId} ICE state: ${pc.iceConnectionState}`);
          if (pc.iceConnectionState === 'failed') {
            debug.log('ICE connection failed, attempting restart...');
            webrtc.restartIce(userId);
          } else if (['disconnected', 'closed'].includes(pc.iceConnectionState)) {
            webrtc.removePeerConnection(userId);
          }
        };

        pc.onsignalingstatechange = () => {
          debug.log(`${userId} signaling state: ${pc.signalingState}`);
        };

        pc.onicecandidate = (event) => {
          if (event.candidate && pc.localDescription && userId !== username) {
            debug.log(`Sending ICE candidate to ${userId}`);
            utils.verifyUserPresence(userId, (isPresent) => {
              if (isPresent) {
                socket.emit('ice-candidate', {
                  candidate: event.candidate,
                  room,
                  callId: state.currentCallId,
                  targetUser: userId,
                  userId: username
                });
              } else {
                debug.warn(`User ${userId} not present, queuing ICE candidate`);
                state.iceQueues[state.currentCallId] = state.iceQueues[state.currentCallId] || {};
                state.iceQueues[state.currentCallId][userId] = state.iceQueues[state.currentCallId][userId] || [];
                state.iceQueues[state.currentCallId][userId].push(event.candidate);
              }
            });
          }
        };

        pc.ontrack = (event) => {
          debug.log(`Track event from ${userId}`, event);
          if (event.streams && event.streams.length > 0) {
            const stream = event.streams[0];
            state.remoteStreams[userId] = stream;
            webrtc.attachRemoteStream(userId, stream);
            debug.log(`Attached remote stream for ${userId}`, stream.getTracks());
          } else {
            debug.warn(`No streams in track event for ${userId}`);
          }
        };

        pc.onnegotiationneeded = async () => {
          if (!state.isCallActive || state.makingOffer || pc.signalingState !== 'stable' || userId === username) {
            debug.log(`Skipping negotiation for ${userId} (state: ${pc.signalingState}, makingOffer: ${state.makingOffer})`);
            return;
          }
          try {
            state.makingOffer = true;
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            utils.verifyUserPresence(userId, (isPresent) => {
              if (isPresent) {
                socket.emit('offer', {
                  offer: pc.localDescription,
                  room,
                  callId: state.currentCallId,
                  targetUser: userId,
                  userId: username
                });
              } else {
                debug.warn(`User ${userId} not present, queuing offer`);
                state.pendingSignaling[userId] = state.pendingSignaling[userId] || [];
                state.pendingSignaling[userId].push({ type: 'offer', data: pc.localDescription });
              }
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
      if (!pc || userId === username) return;

      try {
        debug.log(`Restarting ICE for ${userId}`);
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        utils.verifyUserPresence(userId, (isPresent) => {
          if (isPresent) {
            socket.emit('offer', {
              offer: pc.localDescription,
              room,
              callId: state.currentCallId,
              targetUser: userId,
              userId: username
            });
          } else {
            debug.warn(`User ${userId} not present, queuing ICE restart offer`);
            state.pendingSignaling[userId] = state.pendingSignaling[userId] || [];
            state.pendingSignaling[userId].push({ type: 'offer', data: pc.localDescription });
          }
        });
      } catch (err) {
        debug.error('Error restarting ICE:', err);
      }
    },

    attachRemoteStream: (userId, stream) => {
      debug.log(`Attaching remote stream for ${userId}`);
      if (!stream || !stream.active) {
        debug.warn(`Invalid or inactive stream for ${userId}`);
        return;
      }

      const existing = document.getElementById(`remote-container-${userId}`);
      if (existing) {
        debug.log(`Removing existing video container for ${userId}`);
        existing.remove();
      }

      const container = document.createElement('div');
      container.className = state.callParticipants.length === 2 ? 'video-container remote-fullscreen' : 'video-container';
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
      const videoGrid = document.getElementById('video-grid');
      if (videoGrid) {
        videoGrid.appendChild(container);
      } else {
        debug.error('Video grid not found');
        return;
      }

      video.srcObject = stream;
      video.onloadedmetadata = () => {
        debug.log(`Playing remote video for ${userId}`);
        video.play().catch(e => {
          debug.error('Video play failed:', e);
          webrtc.showVideoPlayButton(container, video);
        });
      };
    },

    establishPeerConnection: async (userId, isInitiator = false) => {
      if (userId === username) {
        debug.warn(`Skipping peer connection for self: ${userId}`);
        return null;
      }
      debug.log(`Establishing connection with ${userId}, initiator: ${isInitiator}`);
      if (state.peerConnections[userId]) {
        debug.log(`Peer connection already exists for ${userId}`);
        return state.peerConnections[userId];
      }

      const pc = webrtc.createPeerConnection(userId);
      if (!pc) {
        debug.error(`Failed to create peer connection for ${userId}`);
        return null;
      }

      state.peerConnections[userId] = pc;

      if (state.localStream) {
        debug.log('Adding local tracks to peer connection');
        const audioTracks = state.localStream.getAudioTracks();
        const videoTracks = state.localStream.getVideoTracks();
        [...audioTracks, ...videoTracks].forEach(track => {
          try {
            pc.addTrack(track, state.localStream);
          } catch (err) {
            debug.error('Error adding track:', err);
          }
        });
      }

      const queue = (state.iceQueues[state.currentCallId] || {})[userId] || [];
      debug.log(`Processing ${queue.length} queued ICE candidates for ${userId}`);
      for (const candidate of queue) {
        try {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } else {
            debug.warn(`Remote description not set, keeping ICE candidate in queue for ${userId}`);
          }
        } catch (err) {
          debug.error('Error adding ICE candidate:', err);
        }
      }
      if (pc.remoteDescription) {
        delete state.iceQueues[state.currentCallId]?.[userId];
      }

      if (state.pendingSignaling[userId]) {
        debug.log(`Processing ${state.pendingSignaling[userId].length} pending signaling messages for ${userId}`);
        for (const msg of state.pendingSignaling[userId]) {
          if (msg.type === 'offer' && userId !== username) {
            socket.emit('offer', {
              offer: msg.data,
              room,
              callId: state.currentCallId,
              targetUser: userId,
              userId: username
            });
          }
        }
        delete state.pendingSignaling[userId];
      }

      if ((isInitiator || state.isCallInitiator) && pc.signalingState === 'stable' && userId !== username) {
        try {
          state.makingOffer = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          utils.verifyUserPresence(userId, (isPresent) => {
            if (isPresent) {
              socket.emit('offer', {
                offer: pc.localDescription,
                room,
                callId: state.currentCallId,
                targetUser: userId,
                userId: username
              });
            } else {
              debug.warn(`User ${userId} not present, queuing offer`);
              state.pendingSignaling[userId] = state.pendingSignaling[userId] || [];
              state.pendingSignaling[userId].push({ type: 'offer', data: pc.localDescription });
            }
          });
        } catch (err) {
          debug.error('Error creating offer:', err);
        } finally {
          state.makingOffer = false;
        }
      }
      return pc;
    },

    addVideoElement: (type, userId, stream, isLocal = false) => {
      const g = document.getElementById('video-grid');
      if (!g) {
        debug.error('Video grid not found');
        return;
      }

      const existing = document.getElementById(`${type}-container-${userId}`);
      if (existing) existing.remove();

      const isTwoUsers = state.callParticipants.length === 2;
      const containerClass = isLocal && isTwoUsers ? 'video-container local-video-container small-video' :
                            isTwoUsers && !isLocal ? 'video-container remote-fullscreen' :
                            `video-container ${isLocal ? 'local-video-container' : ''}`;

      const container = document.createElement('div');
      container.className = containerClass;
      container.id = `${type}-container-${userId}`;

      const video = document.createElement('video');
      video.id = `${type}-video-${userId}`;
      video.autoplay = true;
      video.playsInline = true;
      video.muted = isLocal;

      if (isLocal) {
        video.style.transform = state.currentFacingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
      }

      const label = document.createElement('div');
      label.className = 'video-user-label';
      label.textContent = userId === username ? 'You' : userId;

      container.appendChild(video);
      container.appendChild(label);
      g.appendChild(container);

      if (stream?.active) {
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

      const vc = document.getElementById(`remote-container-${userId}`);
      if (vc) vc.remove();

      const ac = document.getElementById(`audio-container-${userId}`);
      if (ac) ac.remove();

      delete state.remoteStreams[userId];
      delete state.pendingSignaling[userId];
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
            <i class="fas fa-code"></i>
          </button>
        `;
      }

      const isTwoUsers = state.callParticipants.length === 2;
      const videoGridClass = isTwoUsers ? 'video-grid full-screen' : 'video-grid';

      elements.videoCallContainer.innerHTML = `
        <div class="video-call-active">
          <div id="video-grid" class="${videoGridClass}"></div>
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
      elements.videoCallContainer.innerHTML = '';
      media.callSound.pause();
      clearTimeout(state.callTimeout);
    },

    showCallEndedUI: (m) => {
      const d = document.createElement('div');
      d.className = 'call-ended-alert';
      d.innerHTML = `
        <div class="alert-content">
          <p>${typeof m === 'string' ? m : 'Call ended'}</p>
          <button id="close-alert-btn" class="btn btn-primary">OK</button>
        </div>
      `;
      document.body.appendChild(d);
      document.getElementById('close-alert-btn').onclick = () => d.remove();
    },

    startCall: async (t) => {
      if (state.isCallActive) {
        debug.warn('Call already active, ignoring start request');
        return;
      }

      const hasPermissions = await checkMediaPermissions(t);
      if (!hasPermissions) {
        debug.error('Media permissions denied');
        alert(`Please allow ${t === 'video' ? 'camera and microphone' : 'microphone'} access.`);
        return;
      }

      state.isCallActive = true;
      state.currentCallType = t;
      state.currentCallId = utils.generateId();
      state.iceQueues[state.currentCallId] = {};
      state.isCallInitiator = true;
      state.polite = true;

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
        }, 60000);
      } catch (err) {
        debug.error('Call start failed:', err);
        callManager.endCall();
        callManager.showCallEndedUI('Call failed to start: ' + err.message);
      }
    },

    handleIncomingCall: async ({ callType, callId, caller }) => {
      if (!callId) {
        debug.error('Received incoming call with null callId', { callType, caller });
        return;
      }
      if (state.isCallActive) {
        debug.warn('Already in a call, rejecting incoming call');
        socket.emit('reject-call', { room, callId, reason: 'busy' });
        return;
      }

      const hasPermissions = await checkMediaPermissions(callType);
      if (!hasPermissions) {
        debug.error('Media permissions denied for incoming call');
        socket.emit('reject-call', { room, callId, reason: 'media-failure' });
        return;
      }

      const ok = confirm(`${caller} is calling (${callType}). Accept?`);
      if (!ok) {
        socket.emit('reject-call', { room, callId, reason: 'rejected' });
        return;
      }

      state.isCallActive = true;
      state.currentCallType = callType;
      state.currentCallId = callId;
      state.iceQueues[callId] = {};
      state.isCallInitiator = false;
      state.polite = false;

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

        debug.log('Local stream acquired for incoming call');
        callManager.showCallUI(callType);
        socket.emit('call-accepted', { room, callId });
        socket.emit('get-call-participants', { room, callId });

        state.callTimeout = setTimeout(() => {
          if (Object.keys(state.peerConnections).length === 0) {
            callManager.endCall();
            callManager.showCallEndedUI('Failed to establish connection');
          }
        }, 60000);
      } catch (e) {
        debug.error('Media access failed:', e);
        callManager.endCall();
        callManager.showCallEndedUI('Failed to access media devices');
        socket.emit('reject-call', { room, callId, reason: 'media-failure' });
      }
    },

    endCall: () => {
      if (!state.isCallActive) return;
      if (!state.currentCallId) {
        debug.error('Attempted to end call with null callId');
        return;
      }

      debug.log('Ending call and cleaning up resources');
      clearTimeout(state.callTimeout);

      Object.keys(state.peerConnections).forEach(userId => {
        webrtc.removePeerConnection(userId);
      });
      state.peerConnections = {};

      if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
      }

      socket.emit('end-call', { room, callId: state.currentCallId });

      state.isCallActive = false;
      state.currentCallId = null;
      state.currentCallType = null;
      state.iceQueues = {};
      state.pendingSignaling = {};
      state.isAudioMuted = false;
      state.isVideoOff = false;
      state.callParticipants = [];
      state.isCallInitiator = false;
      state.polite = true;
      callManager.hideCallUI();
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

  // Check Media Permissions
  const checkMediaPermissions = async (callType) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video' ? {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        } : false
      });
      stream.getTracks().forEach(track => track.stop());
      return true;
    } catch (err) {
      debug.error('Media permission check failed:', err);
      return false;
    }
  };

  // Keyboard Handling
 const handleKeyboard = () => {
  if (document.activeElement === elements.msgInput) {
    if (!elements.header) {
      debug.error('Header element not found');
      return;
    }
    const headerHeight = elements.header.offsetHeight;
    elements.header.style.position = 'fixed';
    elements.header.style.top = '0';
    elements.header.style.width = '100%';
    elements.chatContainer.style.paddingTop = `${headerHeight}px`;
    elements.chatMessages.style.maxHeight = 'calc(100vh - 180px)';
  } else {
    if (elements.header) {
      elements.header.style.position = '';
      elements.header.style.top = '';
      elements.header.style.width = '';
    }
    elements.chatContainer.style.paddingTop = '0';
    elements.chatMessages.style.maxHeight = '';
  }
};

  // Swipe Handlers
  const handleSwipeStart = (e) => {
    const messageEl = e.target.closest('.message');
    if (!messageEl || messageEl.classList.contains('system')) return;
    
    state.swipeState = {
      target: messageEl,
      startX: e.touches[0].clientX,
      currentX: e.touches[0].clientX,
      isYou: messageEl.classList.contains('you'),
      active: true
    };
    messageEl.classList.add('swiping');
  };

  const handleSwipeMove = (e) => {
    if (!state.swipeState.active) return;
    e.preventDefault();
    
    const deltaX = e.touches[0].clientX - state.swipeState.startX;
    const direction = state.swipeState.isYou ? -1 : 1;
    
    if (deltaX * direction > 0) {
      state.swipeState.currentX = e.touches[0].clientX;
      state.swipeState.target.style.transform = `translateX(${deltaX * 0.5}px)`;
    }
  };

  const handleSwipeEnd = () => {
    if (!state.swipeState.active) return;
    
    const messageEl = state.swipeState.target;
    messageEl.classList.remove('swiping');
    messageEl.style.transform = '';
    
    const deltaX = state.swipeState.currentX - state.swipeState.startX;
    const absDelta = Math.abs(deltaX);
    const direction = state.swipeState.isYou ? -1 : 1;
    
    if (absDelta > state.SWIPE_THRESHOLD && deltaX * direction > 0) {
      const username = messageEl.querySelector('.meta strong')?.textContent;
      const text = messageEl.querySelector('.text')?.textContent;
      const id = messageEl.id;
      
      if (username && text && id) {
        messageHandler.setupReply(username, id, text);
        if ('vibrate' in navigator) navigator.vibrate(50);
      }
    }
    state.swipeState.active = false;
  };

  // CSS Injection for Keyboard Handling and Reply Messages
  const injectStyles = () => {
    const style = document.createElement('style');
    style.textContent = `
      /* Keyboard Handling Styles */
      .keyboard-active #room-header {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        z-index: 1000;
        padding-top: env(safe-area-inset-top);
        background: inherit;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      }
      .keyboard-active .chat-container {
        padding-top: calc(60px + env(safe-area-inset-top)) !important;
      }
      .keyboard-active .chat-messages {
        max-height: calc(100vh - 180px) !important;
        padding-bottom: 80px;
      }
      #reply-preview {
        position: sticky;
        top: 60px;
        z-index: 999;
        display: flex;
        align-items: center;
        padding: 8px;
        background: #e1f5c4;
        border-left: 4px solid #4CAF50;
        border-radius: 4px;
        margin-bottom: 8px;
      }
      .dark #reply-preview {
        background: #2a3e1e;
      }
      .keyboard-active #reply-preview {
        top: calc(60px + env(safe-area-inset-top));
      }

      /* Reply Message Styling */
      .message-reply-container {
        display: flex;
        flex-direction: column;
        border-left: 3px solid #4CAF50;
        padding-left: 8px;
        margin-bottom: 5px;
        cursor: pointer;
        background: rgba(0,0,0,0.05);
        border-radius: 4px;
      }
      .dark .message-reply-container {
        background: rgba(255,255,255,0.1);
      }
      .reply-sender {
        font-weight: bold;
        color: #4CAF50;
        font-size: 0.8em;
      }
      .reply-text {
        color: #555;
        font-size: 0.9em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dark .reply-text {
        color: #ccc;
      }
      .message.highlight {
        animation: highlight 2s ease;
      }
      @keyframes highlight {
        0% { background: rgba(0,150,255,0.3); }
        100% { background: transparent; }
      }
      .dark .message.highlight {
        animation: highlight-dark 2s ease;
      }
      @keyframes highlight-dark {
        0% { background: rgba(0,100,0,0.5); }
        100% { background: transparent; }
      }
      #reply-user {
        font-weight: bold;
        margin-right: 8px;
        color: #4CAF50;
      }
      #reply-text {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #cancel-reply {
        background: none;
        border: none;
        color: #f44336;
        cursor: pointer;
        font-size: 16px;
        margin-left: 8px;
      }
    `;
    document.head.appendChild(style);
  };

  // Event Listeners
  const setupEventListeners = () => {
    elements.cancelReplyBtn.addEventListener('click', e => {
      e.stopPropagation();
      state.replyTo = null;
      elements.replyPreview.classList.add('d-none');
      elements.replyPreview.style.display = 'none';
    });

    elements.chatMessages.addEventListener('touchstart', handleSwipeStart, { passive: true });
    elements.chatMessages.addEventListener('touchmove', handleSwipeMove, { passive: false });
    elements.chatMessages.addEventListener('touchend', handleSwipeEnd, { passive: true });

    elements.msgInput.addEventListener('focus', handleKeyboard);
    elements.msgInput.addEventListener('blur', handleKeyboard);

    elements.msgInput.addEventListener('input', () => {
      messageHandler.handleTyping();
    });

    elements.chatForm.addEventListener('submit', e => {
      e.preventDefault();
      const txt = elements.msgInput.value.trim();
      if (!txt) return;

      debug.log('Sending message:', { text: txt, replyTo: state.replyTo });
      socket.emit('chatMessage', {
        text: txt,
        replyTo: state.replyTo ? {
          id: state.replyTo.id,
          username: state.replyTo.username,
          text: state.replyTo.text
        } : null,
        room,
        time: utils.getCurrentTime(),
        username: username
      });

      elements.msgInput.value = '';
      state.replyTo = null;
      elements.replyPreview.classList.add('d-none');
      elements.replyPreview.style.display = 'none';
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
      debug.log('Socket connected');
      utils.updateConnectionStatus({ text: 'Connected', type: 'connected' });
      state.reconnectAttempts = 0;
      if (state.isCallActive) {
        callManager.endCall();
        callManager.showCallEndedUI('Reconnected, call ended');
      }
      if (!state.hasJoined) {
        socket.emit('joinRoom', { username, room });
        state.hasJoined = true;
        socket.emit('getCallState');
      }
    });

    socket.on('callState', ({ activeCalls, yourRooms }) => {
      debug.log('Received call state:', { activeCalls, yourRooms });
      if (state.isCallActive) return;
      const roomCalls = activeCalls[room];
      if (roomCalls) {
        const call = Object.values(roomCalls).find(c => c.participants.includes(username));
        if (call) {
          debug.log('Active call found, prompting user:', call.callId);
          const ok = confirm(`There is an active ${call.callType} call in ${room}. Rejoin?`);
          if (ok) {
            state.currentCallId = call.callId;
            state.currentCallType = call.callType;
            state.isCallActive = true;
            state.isCallInitiator = false;
            state.polite = false;
            callManager.handleIncomingCall({ callType: call.callType, callId: call.callId, caller: call.participants[0] });
          } else {
            socket.emit('reject-call', { room, callId: call.callId, reason: 'rejected' });
          }
        }
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

    socket.on('error', (msg) => {
      debug.error('Server error:', msg);
      alert(`Error: ${typeof msg === 'string' ? msg : 'An error occurred'}`);
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
      if (userId === username) {
        debug.warn(`Ignoring offer from self: ${userId}`);
        return;
      }
      debug.log(`Received offer from ${userId}`);
      if (callId !== state.currentCallId || !state.isCallActive) {
        debug.warn(`Ignoring offer for call ${callId} (active: ${state.currentCallId})`);
        return;
      }

      const pc = state.peerConnections[userId] || await webrtc.establishPeerConnection(userId);
      if (!pc) {
        debug.error(`No peer connection for ${userId}`);
        return;
      }

      try {
        const offerCollision = (offer.type === 'offer') &&
          (state.makingOffer || pc.signalingState !== 'stable');

        state.ignoreOffer = !state.polite && offerCollision;

        if (state.ignoreOffer) {
          debug.warn(`Ignoring offer from ${userId} due to collision`);
          return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        if (offer.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('answer', {
            answer: pc.localDescription,
            room,
            callId,
            targetUser: userId,
            userId: username
          });
        }

        const queue = (state.iceQueues[state.currentCallId] || {})[userId] || [];
        for (const candidate of queue) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            debug.log(`Applied queued ICE candidate for ${userId}`);
          } catch (err) {
            debug.error('Error adding queued ICE candidate:', err);
          }
        }
        delete state.iceQueues[state.currentCallId]?.[userId];
      } catch (err) {
        debug.error('Offer handling failed:', err);
      }
    });

    socket.on('answer', async ({ answer, userId, callId }) => {
      if (userId === username) {
        debug.warn(`Ignoring answer from self: ${userId}`);
        return;
      }
      debug.log(`Received answer from ${userId}`);
      if (callId !== state.currentCallId) {
        debug.warn(`Ignoring answer for call ${callId}`);
        return;
      }
      const pc = state.peerConnections[userId];
      if (!pc) {
        debug.error(`No peer connection for ${userId}`);
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        const queue = (state.iceQueues[state.currentCallId] || {})[userId] || [];
        for (const candidate of queue) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            debug.log(`Applied queued ICE candidate for ${userId}`);
          } catch (err) {
            debug.error('Error adding queued ICE candidate:', err);
          }
        }
        delete state.iceQueues[state.currentCallId]?.[userId];
      } catch (err) {
        debug.error('Answer handling failed:', err);
      }
    });

    socket.on('ice-candidate', async ({ candidate, userId, callId }) => {
      if (userId === username) {
        debug.warn(`Ignoring ICE candidate from self: ${userId}`);
        return;
      }
      debug.log(`Received ICE candidate from ${userId}`);
      if (callId !== state.currentCallId) {
        debug.warn(`Ignoring ICE candidate for call ${callId}`);
        return;
      }

      try {
        const pc = state.peerConnections[userId] || await webrtc.establishPeerConnection(userId);
        if (pc && pc.remoteDescription && candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          debug.log('Successfully added ICE candidate');
        } else {
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
      state.callParticipants = participants;

      if (state.isCallActive && state.currentCallType === 'video') {
        callManager.showCallUI(state.currentCallType);
        if (state.localStream) {
          webrtc.addVideoElement('local', username, state.localStream, true);
        }
        Object.entries(state.remoteStreams).forEach(([userId, stream]) => {
          webrtc.addVideoElement('remote', userId, stream);
        });
      }

      participants.forEach(async uid => {
        if (uid !== username && !state.peerConnections[uid]) {
          const init = state.isCallInitiator || participants.indexOf(username) < participants.indexOf(uid);
          utils.verifyUserPresence(uid, async (isPresent) => {
            if (isPresent) {
              await webrtc.establishPeerConnection(uid, init);
            } else {
              debug.warn(`User ${uid} not present in room, skipping connection`);
            }
          });
        }
      });
    });

    socket.on('call-accepted', async ({ userId, callId }) => {
      if (userId === username) {
        debug.warn(`Ignoring call-accepted from self: ${userId}`);
        return;
      }
      debug.log(`Call accepted by ${userId}`);
      if (callId !== state.currentCallId || !state.isCallActive) return;
      utils.verifyUserPresence(userId, async (isPresent) => {
        if (isPresent) {
          await webrtc.establishPeerConnection(userId, state.isCallInitiator);
        } else {
          debug.warn(`User ${userId} not present, cannot establish connection`);
        }
      });
    });

    socket.on('reject-call', ({ userId, callId, reason }) => {
      debug.log(`Call rejected by ${userId}: ${reason}`);
      callManager.endCall();
      callManager.showCallEndedUI(reason === 'busy' ? 'User busy' : 'Call rejected');
    });

    socket.on('call-ended', ({ callId }) => {
      debug.log('Call ended by remote peer');
      callManager.endCall();
      callManager.showCallEndedUI('Call ended');
    });

    socket.on('user-joined-call', async ({ userId, callId }) => {
      if (userId === username) {
        debug.warn(`Ignoring user-joined-call from self: ${userId}`);
        return;
      }
      debug.log(`User ${userId} joined call ${callId}`);
      if (callId !== state.currentCallId) return;
      utils.verifyUserPresence(userId, async (isPresent) => {
        if (isPresent) {
          const init = state.isCallInitiator || state.callParticipants.indexOf(username) < state.callParticipants.indexOf(userId);
          await webrtc.establishPeerConnection(userId, init);
        } else {
          debug.warn(`User ${userId} not present, skipping connection`);
        }
      });
    });

    socket.on('user-left-call', ({ userId, callId }) => {
      debug.log(`${userId} left the call`);
      webrtc.removePeerConnection(userId);
      if (Object.keys(state.peerConnections).length === 0) {
        callManager.endCall();
        callManager.showCallEndedUI('All participants left');
      }
    });

    socket.on('mute-state', ({ userId, isAudioMuted }) => {
      debug.log(`User ${userId} ${isAudioMuted ? 'muted' : 'unmuted'} audio`);
    });

    socket.on('video-state', ({ userId, isVideoOff }) => {
      debug.log(`User ${userId} ${isVideoOff ? 'disabled' : 'enabled'} video`);
      const video = document.getElementById(`remote-video-${userId}`);
      if (video) {
        video.style.opacity = isVideoOff ? '0.5' : '1';
      }
    });
  };

  // Initialize Application
  const init = () => {
    if (!username || !room) {
      alert('Missing username or room!');
      window.location.href = '/';
      return;
    }

    debug.log('Initializing application...');
    utils.initDarkMode();
    injectStyles();
    elements.roomName.textContent = room;
    elements.muteBtn.innerHTML = state.isMuted ? '<i class="fas fa-bell-slash"></i>' : '<i class="fas fa-bell"></i>';
    elements.muteBtn.title = state.isMuted ? 'Unmute notifications' : 'Mute notifications';

    setupEventListeners();
    setupSocketHandlers();
    debug.log('Application initialization complete');
  };

  // Start the application
  init();
});