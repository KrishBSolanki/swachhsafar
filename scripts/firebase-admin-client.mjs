// Shared helper for the admin-only maintenance scripts in this folder.
// Uses the Firebase service-account key from the repo root (never bundled into the app).
import { GoogleAuth } from 'google-auth-library';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const PROJECT_ID = 'swachh-safar';

export function serviceAccountPath() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const file = readdirSync(resolve('.')).find((f) => /firebase-adminsdk.*\.json$/.test(f));
  if (!file) throw new Error('Service-account key not found. Set GOOGLE_APPLICATION_CREDENTIALS.');
  return resolve(file);
}

export async function adminClient() {
  const auth = new GoogleAuth({
    keyFile: serviceAccountPath(),
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/firebase'],
  });
  return auth.getClient();
}
