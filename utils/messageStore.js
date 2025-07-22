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
  // Remove markAsSeen completely
}

module.exports = new MessageStore();