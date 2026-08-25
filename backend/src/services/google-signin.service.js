// Verifies a Google Identity Services ID token via Google's tokeninfo
// endpoint — a plain fetch() call, matching the no-SDK style already used
// for Gmail (see gmail.service.js) rather than pulling in google-auth-library.
// Distinct from GOOGLE_CLIENT_ID/SECRET (the Gmail integration's offline-access
// OAuth client) — this is a separate, secret-less "Sign in with Google" client.
export function isGoogleSignInConfigured() {
  return !!process.env.GOOGLE_SIGNIN_CLIENT_ID;
}

function assertGoogleSignInConfigured() {
  if (!isGoogleSignInConfigured()) {
    const err = new Error('Google sign-in is not configured yet — set GOOGLE_SIGNIN_CLIENT_ID in .env');
    err.status = 501;
    throw err;
  }
}

export async function verifyGoogleIdToken(idToken) {
  assertGoogleSignInConfigured();
  if (!idToken) {
    const err = new Error('idToken is required');
    err.status = 400;
    throw err;
  }
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || 'Invalid Google sign-in token');
    err.status = 401;
    throw err;
  }
  if (data.aud !== process.env.GOOGLE_SIGNIN_CLIENT_ID) {
    const err = new Error('Google sign-in token was not issued for this app');
    err.status = 401;
    throw err;
  }
  if (data.email_verified !== 'true' && data.email_verified !== true) {
    const err = new Error('Your Google account email is not verified');
    err.status = 401;
    throw err;
  }
  return { sub: data.sub, email: data.email, name: data.name || data.email };
}
