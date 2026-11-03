// Admin-side verification for live tests: looks up Auth accounts and Firestore docs with the
// service account (bypassing client rules), and cleans up test data.
import { readFileSync } from 'node:fs';
import { adminClient, PROJECT_ID } from '../../scripts/firebase-admin-client.mjs';

const IDT = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}`;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

export function readEnvLocal(path = '.env.local') {
  return Object.fromEntries(
    readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => /^VITE_\w+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
}

export async function createAdmin() {
  const client = await adminClient();
  return {
    async accountsByEmail(email) {
      const { data } = await client.request({ url: `${IDT}/accounts:lookup`, method: 'POST', data: { email: [email] } });
      return data.users ?? [];
    },
    async deleteAccount(localId) {
      await client.request({ url: `${IDT}/accounts:delete`, method: 'POST', data: { localId } });
    },
    async getDoc(path) {
      try {
        const { data } = await client.request({ url: `${FS}/${path}` });
        return data.fields;
      } catch (e) {
        if (e.response?.status === 404) return null;
        throw e;
      }
    },
    async queryProfilesByAuthUid(uid) {
      const { data } = await client.request({
        url: `${FS}:runQuery`, method: 'POST',
        data: { structuredQuery: { from: [{ collectionId: 'app_users' }], where: { fieldFilter: { field: { fieldPath: 'auth_uid' }, op: 'EQUAL', value: { stringValue: uid } } } } },
      });
      return data.filter((r) => r.document).map((r) => r.document);
    },
    async deleteDoc(path) {
      await client.request({ url: `${FS}/${path}`, method: 'DELETE' });
    },
  };
}
