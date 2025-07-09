// utils/messageStore.js
class MessageStore {
  constructor() {
    this.messages = new Map(); // room -> [messages]
  }

  addMessage(room, message) {
    if (!this.messages.has(room)) {
      this.messages.set(room, []);
    }
    this.messages.get(room).push(message);
    return message;
  }

  getMessages(room) {
    return this.messages.get(room) || [];
  }

  markAsSeen(room, messageId, username) {
    const messages = this.messages.get(room);
    if (messages) {
      const message = messages.find(m => m.id === messageId);
      if (message) {
        if (!message.seenBy) message.seenBy = [];
        if (!message.seenBy.includes(username)) {
          message.seenBy.push(username);
          return message;
        }
      }
    }
    return null;
  }
}

module.exports = new MessageStore();