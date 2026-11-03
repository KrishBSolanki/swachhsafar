// Compiles firestore.rules on Firebase (creates an unreleased ruleset) and, with --deploy,
// releases it to Cloud Firestore. Prints the previously released ruleset for rollback:
//   node scripts/deploy-firestore-rules.mjs --rollback <rulesetName>
// Behaviour is verified end-to-end by tests/integration/firebase.live.test.js.
import { readFileSync } from 'node:fs';
import { adminClient, PROJECT_ID } from './firebase-admin-client.mjs';

const api = 'https://firebaserules.googleapis.com/v1';
const releaseName = `projects/${PROJECT_ID}/releases/cloud.firestore`;

try {
  const client = await adminClient();
  const current = (await client.request({ url: `${api}/${releaseName}` })).data;
  console.log('Currently released ruleset:', current.rulesetName);

  const rollbackIdx = process.argv.indexOf('--rollback');
  let rulesetName;
  if (rollbackIdx > -1) {
    rulesetName = process.argv[rollbackIdx + 1];
  } else {
    const source = { files: [{ name: 'firestore.rules', content: readFileSync('firestore.rules', 'utf8') }] };
    // Creating a ruleset compiles it; syntax errors are returned as a 400.
    rulesetName = (await client.request({ url: `${api}/projects/${PROJECT_ID}/rulesets`, method: 'POST', data: { source } })).data.name;
    console.log('Compiled OK:', rulesetName);
  }

  if (process.argv.includes('--deploy') || rollbackIdx > -1) {
    await client.request({ url: `${api}/${releaseName}`, method: 'PATCH', data: { release: { name: releaseName, rulesetName } } });
    console.log('Released:', rulesetName);
    console.log(`Rollback: node scripts/deploy-firestore-rules.mjs --rollback ${current.rulesetName}`);
  }
} catch (e) {
  console.error('Error:', e.response?.status, JSON.stringify(e.response?.data?.error || e.message));
  process.exit(1);
}
