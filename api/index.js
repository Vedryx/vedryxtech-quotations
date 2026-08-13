/* Vercel serverless adapter. server.js exports the raw express app; Vercel's
   Node runtime treats a function-shaped default export as a request handler,
   and express instances are callable that way. Local dev / tests still boot
   through `node server.js`. */
'use strict';
module.exports = require('../server.js').app;
