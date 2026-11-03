// In-memory stand-in for authService (Firebase Auth + Firestore profile) with failure injection.
// Error codes match the real Firebase SDK.

const firebaseError = (code) => Object.assign(new Error(code), { code });

export function createFakeFirebase() {
  const accounts = new Map(); // email -> { uid, password }
  const profiles = new Map(); // docId -> data
  let session = null;
  let nextUid = 1;
  const failures = []; // queue of { op, code } consumed in order
  const calls = { createAccount: 0, signIn: 0, upsertProfile: 0 };

  const maybeFail = (op) => {
    const i = failures.findIndex((f) => f.op === op || f.op === '*');
    if (i > -1) throw firebaseError(failures.splice(i, 1)[0].code);
  };

  const service = {
    async createAccount(email, password) {
      calls.createAccount++;
      maybeFail('createAccount');
      if (accounts.has(email)) throw firebaseError('auth/email-already-in-use');
      const uid = `uid-${nextUid++}`;
      accounts.set(email, { uid, password });
      session = { uid, email };
      return session;
    },
    async signIn(email, password) {
      calls.signIn++;
      maybeFail('signIn');
      const acct = accounts.get(email);
      if (!acct || acct.password !== password) throw firebaseError('auth/invalid-credential');
      session = { uid: acct.uid, email };
      return session;
    },
    async currentAccount() {
      return session;
    },
    async signOut() {
      session = null;
    },
    async upsertProfile(p) {
      calls.upsertProfile++;
      maybeFail('upsertProfile');
      if (!session || session.uid !== p.authUid) throw firebaseError('permission-denied');
      profiles.set(p.uuid, {
        uuid: p.uuid, auth_uid: p.authUid, username: p.username, email: p.email,
        registered_at: p.registeredAt, account_status: 'active', source: 'pwa',
      });
    },
    async findProfileByAuthUid(uid) {
      maybeFail('findProfileByAuthUid');
      return [...profiles.values()].find((p) => p.auth_uid === uid) ?? null;
    },
  };

  return {
    service,
    accounts,
    profiles,
    calls,
    failNext: (op, code) => failures.push({ op, code }),
    clearSession: () => { session = null; },
  };
}
