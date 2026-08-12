// Two storage drivers, picked by STORAGE_DRIVER in .env:
//   - 'local' (default): saves to ./uploads/, served by express.static in app.js.
//     Fine for local dev. Do NOT use this in production on Render/Railway/Fly —
//     their free/starter tiers have EPHEMERAL disks that get wiped on every
//     restart or redeploy, which would silently delete every job photo.
//   - 'supabase': uploads to a Supabase Storage bucket, returns its public URL.
//     You already have a Supabase account — this is the deployment default.
//     Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET in .env.
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 6 * 1024 * 1024; // 6MB — matches the old client-side compression target (1600px/82% JPEG)
const DRIVER = process.env.STORAGE_DRIVER || 'local';

async function saveLocal(buffer, ext, req) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer);
  return `${req.protocol}://${req.get('host')}/uploads/${filename}`;
}

async function saveSupabase(buffer, ext, mime) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_BUCKET) {
    const err = new Error(
      'STORAGE_DRIVER=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET ' +
      'are not set in .env — see docs/DEPLOYMENT.md'
    );
    err.status = 500;
    throw err;
  }
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${filename}`;
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': mime,
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Supabase Storage upload failed (${res.status}): ${text}`);
    err.status = 502;
    throw err;
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${filename}`;
}

uploadsRouter.post('/', async (req, res, next) => {
  try {
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ error: 'dataUrl is required (a data:image/...;base64,... string)' });
    }
    const match = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/s);
    if (!match) return res.status(400).json({ error: 'dataUrl must be a base64 data URI' });
    const [, mime, base64] = match;
    if (!ALLOWED_MIME.has(mime)) {
      return res.status(400).json({ error: `Unsupported image type: ${mime}` });
    }
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: `Image too large (${(buffer.length / 1e6).toFixed(1)}MB) — max 6MB` });
    }
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');

    const url = DRIVER === 'supabase' ? await saveSupabase(buffer, ext, mime) : await saveLocal(buffer, ext, req);
    res.status(201).json({ url });
  } catch (err) {
    next(err);
  }
});
