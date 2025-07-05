const moment = require('moment-timezone');

function formatMessage(username, text, replyTo = null) {
  return {
    username,
    text,
    replyTo,  // Include replyTo info
    time: moment().tz('Asia/Kolkata').format('h:mm a'),  // IST time
  };
}

module.exports = formatMessage;
