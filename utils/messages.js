const moment = require('moment-timezone');

function formatMessage(username, text) {
  return {
    username,
    text,
    time: moment().tz('Asia/Kolkata').format('h:mm a')  // IST time
  };
}

module.exports = formatMessage;
