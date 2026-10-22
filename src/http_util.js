/**
 * The small HTTP helpers the server and the chat engine share: JSON answers, OpenAI-shaped errors, and reading a request body with a cap.
 */
'use strict';

function sendJson(res, status, payload, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}

const ERROR_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'invalid_request_error', 413: 'invalid_request_error', 429: 'rate_limit_error' };

/** An error in the shape the OpenAI SDKs read: { error: { message, type, param, code } }. */
function sendError(res, status, code, message, headers = {}, param = null) {
  sendJson(res, status, { error: { message, type: ERROR_TYPES[status] || 'api_error', param, code } }, headers);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        const err = new Error('The request is larger than this server accepts.');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/**
 * Waits until the client has finished sending (or `ms` has passed). A too-large request is answered only after this: closing a socket
 * that still has unread data resets the connection and can drop the 413 on its way, so the client would see "connection reset" instead.
 */
function finishUpload(req, ms) {
  return new Promise((resolve) => {
    if (req.complete) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); resolve(); }
    req.once('end', done);
    req.once('close', done);
    req.once('error', done);
  });
}

module.exports = { sendJson, sendError, readBody, finishUpload };
