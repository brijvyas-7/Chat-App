const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');

function formatMessage(username, text, replyTo = null) {
  return {
    id: uuidv4(),                          // ✅ Unique ID
    username,                              // ✅ Sender
    text,                                  // ✅ Message content
    replyTo,                               // ✅ Reply context (if any)
    time: moment().tz('Asia/Kolkata').format('h:mm a'),  // ✅ Time in IST
  };
}

module.exports = formatMessage;
