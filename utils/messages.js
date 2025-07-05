const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid'); // Add this

function formatMessage(username, text, replyTo = null) {
  return {
    id: uuidv4(),  // Unique ID for this message
    username,
    text,
    replyTo,
    time: moment().tz('Asia/Kolkata').format('h:mm a'),
  };
}

module.exports = formatMessage;
