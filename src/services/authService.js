// Firebase Authentication (email/password) and the Firestore `app_users` profile.
// The sync service depends only on this small interface, so tests can substitute fakes.
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { collection, doc, getDocs, limit, query, serverTimestamp, setDoc, where } from 'firebase/firestore';

export const PROFILE_COLLECTION = 'app_users';

const account = (user) => ({ uid: user.uid, email: user.email });

export function createAuthService({ auth, firestore }) {
  return {
    async createAccount(email, password) {
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      return account(user);
    },

    async signIn(email, password) {
      const { user } = await signInWithEmailAndPassword(auth, email, password);
      return account(user);
    },

    async currentAccount() {
      await auth.authStateReady();
      return auth.currentUser ? account(auth.currentUser) : null;
    },

    async signOut() {
      await signOut(auth);
    },

    // Profile written for the signed-in user. Only non-secret fields: the security rules
    // reject any other key, including password material.
    async upsertProfile({ uuid, authUid, username, email, registeredAt }) {
      await setDoc(doc(firestore, PROFILE_COLLECTION, uuid), {
        uuid,
        auth_uid: authUid,
        username,
        email,
        registered_at: registeredAt,
        account_status: 'active',
        source: 'pwa',
        synced_at: serverTimestamp(),
      });
    },

    async findProfileByAuthUid(authUid) {
      const snap = await getDocs(
        query(collection(firestore, PROFILE_COLLECTION), where('auth_uid', '==', authUid), limit(1)),
      );
      return snap.empty ? null : snap.docs[0].data();
    },
  };
}
