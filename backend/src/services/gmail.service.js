// Raw fetch() against Google's REST APIs — no googleapis SDK, matching the
// lightweight style already used for Supabase Storage (uploads.routes.js).
// Every function here is safe to call with zero Google Cloud setup: routes
// check isGoogleConfigured()/getStatus() first and return a clean 501
// instead of ever throwing an unhandled error.
import { pool } from '../db/pool.js';
import { encryptToken, decryptToken } from '../utils/crypto.js';
import jwt from 'jsonwebtoken';

const OAUTH_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];

export function isGoogleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function assertGoogleConfigured() {
  if (!isGoogleConfigured()) {
    const err = new Error('Gmail is not configured yet — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in .env');
    err.status = 501;
    throw err;
  }
}

export async function getStatus(officeId) {
  const configured = isGoogleConfigured();
  if (!configured) return { configured: false, connected: false, googleEmail: null };
  const { rows } = await pool.query('SELECT google_email FROM gmail_oauth_tokens WHERE office_id = $1', [officeId]);
  return { configured: true, connected: rows.length > 0, googleEmail: rows[0]?.google_email || null };
}

// The OAuth callback is hit directly by Google redirecting the user's
// browser — it can't carry an Authorization header the way every other
// route does. This signs the acting user/office into a short-lived JWT
// carried through the `state` param instead, verified in the callback route.
export function buildAuthUrl(user) {
  assertGoogleConfigured();
  const state = jwt.sign({ sub: user.sub, officeId: user.officeId }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPES.join(' '),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function verifyState(state) {
  return jwt.verify(state, process.env.JWT_SECRET); // throws if expired/tampered
}

export async function exchangeCodeForTokens(code) {
  assertGoogleConfigured();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Google token exchange failed (${res.status}): ${text}`);
    err.status = 502;
    throw err;
  }
  return res.json(); // { access_token, refresh_token, expires_in, scope, ... }
}

async function refreshAccessToken(refreshToken) {
  assertGoogleConfigured();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const err = new Error('Failed to refresh Google access token — the connection may need to be re-authorized');
    err.status = 502;
    throw err;
  }
  return res.json();
}

export async function saveConnection(officeId, userId, { refreshToken, googleEmail, scope }) {
  const { encrypted, iv, authTag } = encryptToken(refreshToken);
  await pool.query(
    `INSERT INTO gmail_oauth_tokens (office_id, connected_by_user_id, google_email, encrypted_refresh_token, encryption_iv, encryption_auth_tag, scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (office_id) DO UPDATE SET
       connected_by_user_id = $2, google_email = $3, encrypted_refresh_token = $4,
       encryption_iv = $5, encryption_auth_tag = $6, scopes = $7, updated_at = now()`,
    [officeId, userId, googleEmail || null, encrypted, iv, authTag, scope || null]
  );
}

export async function disconnect(officeId) {
  await pool.query('DELETE FROM gmail_oauth_tokens WHERE office_id = $1', [officeId]);
}

async function getAccessToken(officeId) {
  const { rows } = await pool.query('SELECT * FROM gmail_oauth_tokens WHERE office_id = $1', [officeId]);
  if (!rows.length) {
    const err = new Error('Gmail is not connected for this office');
    err.status = 400;
    throw err;
  }
  const refreshToken = decryptToken({ encrypted: rows[0].encrypted_refresh_token, iv: rows[0].encryption_iv, authTag: rows[0].encryption_auth_tag });
  const { access_token } = await refreshAccessToken(refreshToken);
  return access_token;
}

export async function searchInquiries(officeId, query = 'is:unread') {
  const accessToken = await getAccessToken(officeId);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = new Error(`Gmail inbox search failed (${res.status})`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Gmail's MIME structure nests parts arbitrarily (plain text, HTML, and
// attachments as siblings, sometimes inside a multipart/alternative wrapper
// inside another multipart/mixed wrapper) — walks it looking for the first
// real text/plain part before falling back to whatever text exists.
function extractPlainTextBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBase64Url(payload.body.data);
  if (Array.isArray(payload.parts)) {
    const plainPart = payload.parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
    if (plainPart) return decodeBase64Url(plainPart.body.data);
    for (const part of payload.parts) {
      const nested = extractPlainTextBody(part);
      if (nested) return nested;
    }
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data); // e.g. bare text/html with no parts
  return '';
}

function headerValue(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// Fetches one message's full content for human review (inbox triage / new
// job creation from an email) — deliberately not persisted anywhere; the
// body is capped since this is for a person to read, not an archive.
export async function getMessageDetail(officeId, messageId) {
  const accessToken = await getAccessToken(officeId);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = new Error(`Gmail message fetch failed (${res.status})`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const headers = data.payload?.headers;
  let body = extractPlainTextBody(data.payload).trim();
  if (body && /<[a-z][\s\S]*>/i.test(body)) body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    id: data.id,
    threadId: data.threadId,
    from: headerValue(headers, 'From'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    snippet: data.snippet || '',
    body: body.slice(0, 4000),
  };
}

// Recent inbox messages with full content, for the Mail tab's "Check inbox"
// review flow. One Gmail API call per message (N+1) — acceptable for a
// manually-triggered check of ~15 messages, not a background poller.
export async function listInboxCandidates(officeId, { query = 'in:inbox newer_than:30d', maxResults = 15 } = {}) {
  const list = await searchInquiries(officeId, query);
  const ids = (list.messages || []).slice(0, maxResults).map((m) => m.id);
  const details = [];
  for (const id of ids) {
    try { details.push(await getMessageDetail(officeId, id)); }
    catch { /* one message failing to fetch shouldn't fail the whole batch */ }
  }
  return details;
}

function buildMimeMessage({ to, subject, body }) {
  const lines = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

async function sendMessage(officeId, { to, subject, body }) {
  const accessToken = await getAccessToken(officeId);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildMimeMessage({ to, subject, body }) }),
  });
  if (!res.ok) {
    const err = new Error(`Gmail send failed (${res.status})`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

export async function sendCadEmail(officeId, { to, subject, body }) {
  return sendMessage(officeId, { to, subject, body });
}

// No rate-limiting here yet — a known gap for scaffolding, worth adding
// (a delay between sends, or a batch API call) before real bulk use.
export async function sendBulkMail(officeId, { recipients, subject, body }) {
  const results = [];
  for (const to of recipients) {
    try {
      await sendMessage(officeId, { to, subject, body });
      results.push({ to, ok: true });
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }
  return results;
}
