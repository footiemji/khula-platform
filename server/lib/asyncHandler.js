// Express 4 doesn't catch rejected promises from async route handlers on
// its own — an unhandled rejection would otherwise crash the process or
// hang the request. Wrap every async handler with this so errors flow into
// the error-handling middleware in server/index.js like any sync throw.
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
