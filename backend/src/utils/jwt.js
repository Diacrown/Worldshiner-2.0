import jwt from 'jsonwebtoken';
import 'dotenv/config';

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

if (!SECRET || SECRET === 'change-this-to-a-long-random-string') {
  console.warn(
    '[auth] WARNING: JWT_SECRET is missing or still the placeholder value. ' +
    'Set a real random secret in .env before running this anywhere but your own machine.'
  );
}

export function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token) {
  // signToken() uses jsonwebtoken's default (HS256) with a string secret;
  // pin it so verification can never be talked into another algorithm.
  const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
  // Session tokens never carry a `purpose`. Special-purpose tokens signed with
  // the same secret (e.g. the Gmail OAuth `state`) must not be usable as one.
  if (payload && payload.purpose) throw new Error('Token is not a session token');
  return payload;
}
