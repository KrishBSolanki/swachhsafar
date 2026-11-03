// One-time: registers a Firebase Web app (if missing) and writes its public config to .env.local.
import { writeFileSync } from 'node:fs';
import { adminClient, PROJECT_ID } from './firebase-admin-client.mjs';

const DISPLAY_NAME = 'Swachh Safar PWA';
const client = await adminClient();
const base = `https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}`;

let { data } = await client.request({ url: `${base}/webApps` });
let app = (data.apps || []).find((a) => a.displayName === DISPLAY_NAME);

if (!app) {
  const op = (await client.request({ url: `${base}/webApps`, method: 'POST', data: { displayName: DISPLAY_NAME } })).data;
  let done = op;
  while (!done.done) {
    await new Promise((r) => setTimeout(r, 2000));
    done = (await client.request({ url: `https://firebase.googleapis.com/v1beta1/${op.name}` })).data;
  }
  if (done.error) throw new Error(done.error.message);
  app = done.response;
  console.log('Created web app', app.appId);
} else {
  console.log('Web app already exists', app.appId);
}

const config = (await client.request({ url: `${base}/webApps/${app.appId}/config` })).data;
const env = [
  '# Firebase Web app config (public client identifiers, not secrets).',
  `VITE_FIREBASE_API_KEY=${config.apiKey}`,
  `VITE_FIREBASE_AUTH_DOMAIN=${config.authDomain}`,
  `VITE_FIREBASE_PROJECT_ID=${config.projectId}`,
  `VITE_FIREBASE_STORAGE_BUCKET=${config.storageBucket || ''}`,
  `VITE_FIREBASE_MESSAGING_SENDER_ID=${config.messagingSenderId}`,
  `VITE_FIREBASE_APP_ID=${config.appId}`,
  '',
].join('\n');
writeFileSync('.env.local', env);
console.log('Wrote .env.local (keys:', Object.keys(config).join(', '), ')');
