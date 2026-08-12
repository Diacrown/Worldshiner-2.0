// Centralized error handling — every route calls next(err) on failure instead
// of formatting its own error response, so the shape of an error is
// consistent everywhere (the old app had no server at all, so every file
// invented its own alert()/toast() error handling independently).
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[error]', err);
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route: ${req.method} ${req.originalUrl}` });
}
