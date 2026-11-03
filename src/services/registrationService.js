// Local (offline-capable) registration: validate, hash, and persist the user plus its
// outbox operation in one SQLite transaction. No network access happens here.
import { createUserRepository } from '../database/userRepository.js';
import { createOutboxRepository } from '../database/outboxRepository.js';
import { hashPassword } from '../utils/passwordHash.js';
import { validateRegistration } from '../utils/validation.js';

export class RegistrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

const isUniqueViolation = (e) => /UNIQUE constraint failed/i.test(e?.message ?? '');

export function createRegistrationService({ db, hashOptions, now = () => new Date().toISOString() }) {
  const users = createUserRepository(db);
  const outbox = createOutboxRepository(db);

  return {
    async register({ email: rawEmail, password }) {
      const { valid, errors, email } = validateRegistration({ email: rawEmail, password });
      if (!valid) throw new RegistrationError('validation', 'Please fix the highlighted fields.', { fieldErrors: errors });

      const existing = await users.findByEmail(email);
      if (existing) {
        throw new RegistrationError('duplicate', 'This email is already registered on this device.', {
          fieldErrors: { email: 'This email is already registered on this device.' },
          existing,
        });
      }

      const { hash, salt } = await hashPassword(password, hashOptions);
      const timestamp = now();
      const user = {
        id: crypto.randomUUID(),
        username: email,
        email,
        password_hash: hash,
        password_salt: salt,
        registration_status: 'pending',
        sync_status: 'pending',
        created_at: timestamp,
        updated_at: timestamp,
      };
      const outboxEntry = {
        id: crypto.randomUUID(),
        entity_type: 'user',
        entity_id: user.id,
        operation: 'register',
        // Cloud-safe payload only: never the password, hash or salt.
        payload: { id: user.id, username: user.username, email, created_at: timestamp },
        created_at: timestamp,
      };

      try {
        await db.transaction([users.insertStatement(user), outbox.insertStatement(outboxEntry)]);
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new RegistrationError('duplicate', 'This email is already registered on this device.', {
            fieldErrors: { email: 'This email is already registered on this device.' },
          });
        }
        throw e;
      }
      return users.findById(user.id);
    },
  };
}
