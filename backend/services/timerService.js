function remainingSeconds(deadline, now = Date.now()) { return Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000)); }
module.exports = { remainingSeconds };
