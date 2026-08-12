import crypto from 'node:crypto';

// AES-256-GCM for storing OAuth refresh tokens at rest. The missing-env-var
// check happens INSIDE these functions, never at module top-level — a
// top-level throw would crash the whole server at boot the moment this file
// is imported, before Gmail is even configured.
function getKey() {
  const hex = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    const err = new Error('GOOGLE_TOKEN_ENCRYPTION_KEY is not set — generate one with `openssl rand -hex 32`');
    err.status = 501;
    throw err;
  }
  return Buffer.from(hex, 'hex');
}

export function encryptToken(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptToken({ encrypted, iv, authTag }) {
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}
