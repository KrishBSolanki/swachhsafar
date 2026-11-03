import { describe, expect, it } from 'vitest';
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from '../../src/utils/passwordHash.js';

describe('PBKDF2 password verifier', () => {
  it('uses 600k iterations by default and never contains the password', async () => {
    const { hash, salt } = await hashPassword('safar2026x');
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(hash).toMatch(/^pbkdf2-sha256\$600000\$[A-Za-z0-9+/]+=*$/);
    expect(hash).not.toContain('safar2026x');
    expect(atob(salt)).toHaveLength(16);
    expect(await verifyPassword('safar2026x', hash, salt)).toBe(true);
  });

  it('uses a fresh random salt each time', async () => {
    const a = await hashPassword('same-password1', { iterations: 1000 });
    const b = await hashPassword('same-password1', { iterations: 1000 });
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('rejects wrong passwords and malformed hashes', async () => {
    const { hash, salt } = await hashPassword('safar2026x', { iterations: 1000 });
    expect(await verifyPassword('safar2026X', hash, salt)).toBe(false);
    expect(await verifyPassword('safar2026x', 'md5$1$abc', salt)).toBe(false);
    expect(await verifyPassword('safar2026x', 'garbage', salt)).toBe(false);
  });
});
