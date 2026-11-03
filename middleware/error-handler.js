// Error handler middleware — used by server.js
// Centralized error handling that sends JSON error responses with appropriate
// status codes and formats, while avoiding leaking sensitive information.

/**
 * Centralized error response helper.
 * Sends a JSON error response with the given status code and message.
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message to send to client
 * @param {object} [extra] - Additional data to include in the response
 */
function errorResponse(statusCode, message, extra) {
  const body = { message };
  if (extra) {
    Object.assign(body, extra);
  }
  return body;
}

/**
 * Global error handler middleware.
 * Catches errors from async route handlers and sends appropriate error responses.
 * Distinguishes between client errors (4xx) and server errors (5xx).
 * @param {Error} err - The error object
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {function} next - Express next function
 */
function errorHandler(err, req, res, _next) {
  // Determine status code; default to 500 for unhandled errors
  const statusCode = err.statusCode || 500;
  const message = statusCode === 413
    ? 'Request body is too large.'
    : statusCode >= 500
    ? 'An internal server error occurred.'
    : err.message || 'Request failed.';

  // Log the full error for server-side debugging (never in production client response)
  console.error(`[${req.id || 'unknown'}] ${statusCode} error: ${message}`);
  if (err.stack) {
    console.error(err.stack);
  }

  // Send error response
  res.status(statusCode).json(errorResponse(statusCode, message));
}

// CSP_CONNECT_SOURCES is defined in server.js; not available in this module
// The error handler deliberately does not set CSP headers to avoid duplication

/**
 * Wrap an async route handler to catch errors and pass them to errorHandler.
 * Usage: app.get('/route', wrapAsyncHandler(async (req, res) => { ... }));
 * @param {function} handler - Async route handler function
 * @returns {function} Express middleware function
 */
function wrapAsyncHandler(handler) {
  return function asyncHandler(req, res, next) {
    handler(req, res).catch((err) => {
      // Set status code based on error type
      err.statusCode = err.statusCode || err.status || 500;
      next(err);
    });
  };
}

module.exports = {
  errorHandler,
  wrapAsyncHandler,
  errorResponse
};
