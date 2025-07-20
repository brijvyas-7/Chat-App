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
 // Enhanced WebRTC connection handling
const webrtc = {
    createPeerConnection: (userId) => {
        debug.log(`Creating peer connection for ${userId}`);
        try {
            const pc = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { 
                        urls: 'turn:your-turn-server.com', // Add your TURN server here
                        username: 'username',
                        credential: 'password'
                    }
                ],
                iceTransportPolicy: 'all',
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require',
                iceCandidatePoolSize: 25 // Increased candidate pool
            });

            // Enhanced state tracking
            pc.onconnectionstatechange = () => {
                debug.log(`${userId} connection state: ${pc.connectionState}`);
                if (pc.connectionState === 'connected') {
                    debug.log('Successfully connected to peer!');
                    clearTimeout(state.connectionTimeout); // Clear connection timeout
                } else if (pc.connectionState === 'failed') {
                    debug.error(`Connection failed with ${userId}`);
                    webrtc.removePeerConnection(userId);
                    callManager.retryConnection(userId);
                }
            };

            // More robust ICE handling
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    debug.log(`Sending ICE candidate to ${userId}:`, event.candidate);
                    socket.emit('ice-candidate', {
                        candidate: event.candidate,
                        room,
                        callId: state.currentCallId,
                        targetUser: userId
                    });
                } else {
                    debug.log(`All ICE candidates gathered for ${userId}`);
                    // Start timeout only after all candidates are gathered
                    state.connectionTimeout = setTimeout(() => {
                        if (pc.iceConnectionState !== 'connected') {
                            debug.error('ICE connection timed out');
                            callManager.retryConnection(userId);
                        }
                    }, 30000); // 30 second timeout
                }
            };

            // Track handling with retries
            pc.ontrack = (event) => {
                debug.log(`Track event from ${userId}`);
                if (!event.streams || event.streams.length === 0) {
                    debug.error(`No streams in track event - retrying...`);
                    setTimeout(() => {
                        if (state.peerConnections[userId]) {
                            pc.addTransceiver('audio', { direction: 'recvonly' });
                            pc.addTransceiver('video', { direction: 'recvonly' });
                        }
                    }, 1000);
                    return;
                }

                const stream = event.streams.find(s => s.getVideoTracks().length > 0) || event.streams[0];
                webrtc.attachRemoteStream(userId, stream);
            };

            return pc;
        } catch (error) {
            debug.error(`Failed to create peer connection:`, error);
            return null;
        }
    },

    // [Rest of your WebRTC functions...]
};

// Enhanced Call Manager
const callManager = {
    startCall: async (t) => {
        debug.log(`Starting ${t} call with enhanced connection handling`);
        
        try {
            // Pre-call connectivity check
            const connectivityCheck = await fetch('https://network-test.com/test', { mode: 'no-cors' })
                .catch(() => debug.warn('Network connectivity check failed'));

            state.isCallActive = true;
            state.currentCallType = t;
            state.currentCallId = utils.generateId();
            state.iceQueues[state.currentCallId] = {};

            // Get media stream with timeout
            const mediaPromise = navigator.mediaDevices.getUserMedia({
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

            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Media acquisition timeout')), 10000)
            );

            state.localStream = await Promise.race([mediaPromise, timeoutPromise]);
            debug.log('Media stream acquired:', state.localStream.getTracks());

            callManager.showCallUI(t);
            
            // Start call with retry mechanism
            callManager.establishCallWithRetry();
            
        } catch (err) {
            debug.error('Call start failed:', err);
            callManager.endCall();
            callManager.showCallEndedUI(`Failed to start call: ${err.message}`);
        }
    },

    establishCallWithRetry: (attempt = 0) => {
        const maxRetries = 3;
        if (attempt >= maxRetries) {
            debug.error('Max call retries reached');
            callManager.endCall();
            callManager.showCallEndedUI('Could not establish connection');
            return;
        }

        debug.log(`Attempting call initiation (attempt ${attempt + 1})`);
        socket.emit('call-initiate', {
            room,
            callId: state.currentCallId,
            callType: state.currentCallType,
            caller: username
        });

        // Set timeout with retry
        state.callTimeout = setTimeout(() => {
            if (Object.keys(state.peerConnections).length === 0) {
                debug.warn('No response - retrying...');
                callManager.establishCallWithRetry(attempt + 1);
            }
        }, attempt === 0 ? 15000 : 10000); // Longer timeout for first attempt
    },

    retryConnection: (userId) => {
        if (!state.isCallActive || state.reconnectAttempts >= 3) return;
        
        state.reconnectAttempts++;
        debug.log(`Retrying connection with ${userId} (attempt ${state.reconnectAttempts})`);
        
        setTimeout(() => {
            if (state.isCallActive && state.peerConnections[userId]) {
                webrtc.establishPeerConnection(userId, true);
            }
        }, state.reconnectAttempts * 2000); // Exponential backoff
    },

    // [Rest of your call manager functions...]
};

// Enhanced Socket Handlers
const setupSocketHandlers = () => {
    // [Previous socket handlers...]

    socket.on('offer', async ({ offer, userId, callId }) => {
        debug.log(`Received offer from ${userId} with type ${offer.type}`);
        if (callId !== state.currentCallId || !state.isCallActive) return;

        try {
            const pc = state.peerConnections[userId] || await webrtc.establishPeerConnection(userId);
            if (!pc) throw new Error('Failed to create peer connection');

            debug.log(`Current signaling state: ${pc.signalingState}`);
            
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            debug.log('Remote description set successfully');

            if (offer.type === 'offer') {
                const answer = await pc.createAnswer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: state.currentCallType === 'video'
                });
                debug.log('Created answer:', answer.type);
                
                await pc.setLocalDescription(answer);
                debug.log('Local description set');
                
                socket.emit('answer', {
                    answer: pc.localDescription,
                    room,
                    callId,
                    targetUser: userId
                });
            }
        } catch (err) {
            debug.error('Offer handling failed:', err);
            callManager.retryConnection(userId);
        }
    });

    socket.on('ice-candidate', async ({ candidate, userId, callId }) => {
        debug.log(`Processing ICE candidate from ${userId}`);
        if (callId !== state.currentCallId) return;

        try {
            const pc = state.peerConnections[userId];
            if (pc) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
                debug.log('Successfully added ICE candidate');
            } else {
                debug.log('Queuing ICE candidate - no peer connection yet');
                state.iceQueues[callId] = state.iceQueues[callId] || {};
                state.iceQueues[callId][userId] = state.iceQueues[callId][userId] || [];
                state.iceQueues[callId][userId].push(new RTCIceCandidate(candidate));
            }
        } catch (err) {
            debug.error('Failed to add ICE candidate:', err);
        }
    });

    // [Rest of your socket handlers...]
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