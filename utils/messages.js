const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');

function formatMessage(username, text, replyTo = null, time = moment().tz('Asia/Kolkata').format('h:mm a')) {
  return {
    id: uuidv4(),
    username,
    text,
    replyTo,
    time
  };
}

module.exports = formatMessage;