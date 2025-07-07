const socket = io();
const msgInput = document.getElementById('msg');
const chatMessages = document.getElementById('chat-messages');
const typingIndicator = document.getElementById('typing-indicator');
const typingUserName = document.getElementById('typing-user');
const replyPreview = document.getElementById('reply-preview');
const replyUserElem = document.getElementById('reply-user');
const replyTextElem = document.getElementById('reply-text');
const cancelReplyBtn = document.getElementById('cancel-reply');
const themeBtn = document.getElementById('theme-toggle');
const muteBtn = document.getElementById('mute-toggle');
const notificationSound = new Audio('/sounds/notification.mp3');

const { username, room } = Qs.parse(location.search, { ignoreQueryPrefix: true });
let replyTo = null, isMuted = localStorage.getItem('isMuted') === 'true';
const typingUsers = new Set();

// Join room
socket.emit('joinRoom', { username, room });

// Utility
function scrollToBottom(force=false){
  const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 100;
  if(force || nearBottom){
    requestAnimationFrame(() => chatMessages.scrollTop = chatMessages.scrollHeight);
  }
}

document.body.addEventListener('click', () => { notificationSound.play().catch(()=>{}); }, { once:true });

// Handle incoming message
socket.on('message', msg => {
  if(msg.username!==username && msg.username!=='ChatApp Bot' && !isMuted){
    notificationSound.play().catch(()=>{});
  }
  addMessage(msg);
});

// Show typing
socket.on('showTyping', ({username: u}) => {
  if(u!==username && !typingUsers.has(u)){
    typingUsers.add(u);
    typingUserName.textContent = u;
    typingIndicator.classList.remove('d-none');
    scrollToBottom();
    setTimeout(()=>{
      typingUsers.delete(u);
      if(!typingUsers.size) typingIndicator.classList.add('d-none');
    },1500);
  }
});

function addMessage({ id: msgID, username:u, text, time, replyTo:r }){
  typingIndicator.classList.add('d-none');
  const div = document.createElement('div');
  div.className = 'message ' + (u===username?'you':'other');
  div.id = msgID;

  if(r){
    const rb = document.createElement('div');
    rb.className = 'reply-box';
    rb.innerHTML = `<strong>${r.username}</strong>: ${r.text}`;
    rb.addEventListener('click', ()=>{
      const target = document.getElementById(r.id);
      if(target) target.scrollIntoView({behavior:'smooth',block:'center'});
    });
    div.appendChild(rb);
  }

  div.innerHTML += `<div class="meta"><strong>${u}</strong> @ ${time}</div><div class="text">${text}</div>`;

  // swipe or context reply
  let sx=0;
  div.addEventListener('touchstart', e=>sx=e.touches[0].clientX);
  div.addEventListener('touchend', e=>{
    if(e.changedTouches[0].clientX - sx > 60){
      replyTo = { id: msgID, username:u, text };
      replyUserElem.textContent = u;
      replyTextElem.textContent = text;
      replyPreview.classList.remove('d-none');
      msgInput.focus();
      navigator.vibrate?.(100);
    }
  });
  div.addEventListener('contextmenu', e=>{
    e.preventDefault();
    replyTo = { id: msgID, username:u, text };
    replyUserElem.textContent = u;
    replyTextElem.textContent = text;
    replyPreview.classList.remove('d-none');
    msgInput.focus();
    navigator.vibrate?.(100);
  });

  chatMessages.appendChild(div);
  scrollToBottom();
}

// Form submit
document.getElementById('chat-form').addEventListener('submit', e=>{
  e.preventDefault();
  const txt = msgInput.value.trim();
  if(!txt) return;
  socket.emit('chatMessage', { text: txt, replyTo: replyTo ? {...replyTo} : null });
  msgInput.value='';
  replyTo=null;
  replyPreview.classList.add('d-none');
});

// Typing event
msgInput.addEventListener('input', ()=>socket.emit('typing'));

// Scroll on focus
msgInput.addEventListener('focus', ()=>setTimeout(()=>scrollToBottom(true), 200));

// Cancel reply
cancelReplyBtn.addEventListener('click', ()=>{
  replyTo=null;
  replyPreview.classList.add('d-none');
});

// Theme toggle
themeBtn.addEventListener('click', ()=>{
  document.body.classList.toggle('dark');
  themeBtn.querySelector('i').classList.toggle('fa-moon');
  themeBtn.querySelector('i').classList.toggle('fa-sun');
});

// Mute toggle
muteBtn.addEventListener('click', ()=>{
  isMuted=!isMuted;
  localStorage.setItem('isMuted', isMuted);
  muteBtn.querySelector('i').classList.toggle('fa-bell-slash');
});

// Safe viewport height
function updateSafeVH(){
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--safe-vh', `${vh}px`);
}
if(window.visualViewport){
  updateSafeVH();
  window.visualViewport.addEventListener('resize', updateSafeVH);
  window.visualViewport.addEventListener('scroll', updateSafeVH);
} else window.addEventListener('resize', updateSafeVH);
