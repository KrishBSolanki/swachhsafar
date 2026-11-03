// Local password verifier using PBKDF2-HMAC-SHA256 via Web Crypto.
// Stored hash format: "pbkdf2-sha256$<iterations>$<base64 derived key>"; salt is stored separately.
// This verifier exists only to check re-entered passwords locally; it is never sent to Firebase.

export const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const KEY_BITS = 256;

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password, { iterations = PBKDF2_ITERATIONS } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, salt, iterations);
  return { hash: `pbkdf2-sha256$${iterations}$${toBase64(derived)}`, salt: toBase64(salt) };
}

export async function verifyPassword(password, storedHash, storedSalt) {
  const [scheme, iterationsText, expectedB64] = String(storedHash).split('$');
  const iterations = Number(iterationsText);
  if (scheme !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || !expectedB64) return false;
  const expected = fromBase64(expectedB64);
  const actual = await derive(password, fromBase64(storedSalt), iterations);
  if (actual.length !== expected.length) return false;
  // Constant-time comparison.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
