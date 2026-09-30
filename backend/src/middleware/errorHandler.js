// Centralized error handling — every route calls next(err) on failure instead
// of formatting its own error response, so the shape of an error is
// consistent everywhere (the old app had no server at all, so every file
// invented its own alert()/toast() error handling independently).
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[error]', err);
  }
  // Unexpected errors (no explicit status: database errors, bugs) keep their
  // detail in the server log only. Errors a service threw ON PURPOSE with a
  // status (501 "not configured", 502 upstream failure) carry a message written
  // for the user, so those still reach the client unchanged.
  if (!err.status) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route: ${req.method} ${req.originalUrl}` });
}
