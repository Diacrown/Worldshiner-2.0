import { Router } from 'express';
import { requireAuth, requireOrgAdminOrAbove, resolveWriteOfficeId } from '../middleware/auth.js';
import * as ImportService from '../services/import.service.js';

export const importRouter = Router();
importRouter.use(requireAuth, requireOrgAdminOrAbove);

const ALLOWED_MIME = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
// Base64 encoding adds ~33% overhead, and this rides inside the same
// express.json({limit:'8mb'}) body cap as image uploads (app.js) — keep
// comfortably under that after encoding, not right at the edge.
const MAX_BYTES = 5 * 1024 * 1024;

function decodeFile(req) {
  const { fileDataUrl, filename } = req.body || {};
  if (!fileDataUrl || typeof fileDataUrl !== 'string') {
    const err = new Error('fileDataUrl is required (a base64 data URI)');
    err.status = 400;
    throw err;
  }
  if (!filename || typeof filename !== 'string') {
    const err = new Error('filename is required');
    err.status = 400;
    throw err;
  }
  const match = fileDataUrl.match(/^data:([\w/+.-]*);base64,(.+)$/s);
  if (!match) {
    const err = new Error('fileDataUrl must be a base64 data URI');
    err.status = 400;
    throw err;
  }
  const [, mime, base64] = match;
  // Browsers sometimes report an empty or generic mime for .csv depending on
  // OS association — fall back to the filename extension rather than
  // rejecting a legitimate CSV outright.
  const looksLikeCsv = /\.csv$/i.test(filename);
  if (mime && !ALLOWED_MIME.has(mime) && !looksLikeCsv) {
    const err = new Error(`Unsupported file type: ${mime || '(unknown)'} — upload a .csv or .xlsx file`);
    err.status = 400;
    throw err;
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_BYTES) {
    const err = new Error(`File too large (${(buffer.length / 1e6).toFixed(1)}MB) — max 8MB`);
    err.status = 413;
    throw err;
  }
  return { buffer, filename };
}

importRouter.post('/preview', async (req, res, next) => {
  try {
    const { buffer, filename } = decodeFile(req);
    const preview = await ImportService.parsePreview(buffer, filename);
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

importRouter.post('/commit', async (req, res, next) => {
  try {
    const { buffer, filename } = decodeFile(req);
    const { mapping } = req.body || {};
    if (!mapping || typeof mapping !== 'object') {
      return res.status(400).json({ error: 'mapping is required (column index -> field name)' });
    }
    const officeId = await resolveWriteOfficeId(req);
    const result = await ImportService.commitImport(req.user, officeId, { buffer, filename, mapping });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
