import { describe, expect, it } from 'vitest';
import { normalizeEmail, passwordStrength, validateEmail, validatePassword, validateRegistration } from '../../src/utils/validation.js';

describe('email validation', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Ravi.Kumar@Example.COM ')).toBe('ravi.kumar@example.com');
  });

  it.each(['', '   ', 'plain', 'a@b', 'a@b.c', 'a b@c.com', '@example.com'])('rejects %j', (email) => {
    expect(validateEmail(email)).not.toBeNull();
  });

  it.each(['user@example.com', ' USER@Example.in ', 'first.last+tag@sub.domain.org'])('accepts %j', (email) => {
    expect(validateEmail(email)).toBeNull();
  });
});

describe('password validation', () => {
  it('requires a value', () => expect(validatePassword('')).toMatch(/required/));
  it('requires at least 8 characters', () => expect(validatePassword('abc123')).toMatch(/at least 8/));
  it('requires a letter and a number', () => {
    expect(validatePassword('abcdefgh')).toMatch(/letter and one number/);
    expect(validatePassword('12345679')).toMatch(/letter and one number/);
  });
  it('rejects common passwords', () => expect(validatePassword('Password123')).toMatch(/too common/));
  it('rejects overly long passwords', () => expect(validatePassword(`a1${'x'.repeat(130)}`)).toMatch(/at most/));
  it('accepts a reasonable password and does not trim it', () => {
    expect(validatePassword('clean journey 7')).toBeNull();
    expect(validatePassword(' safar2026 ')).toBeNull();
  });

  it('scores strength', () => {
    expect(passwordStrength('').score).toBe(0);
    expect(passwordStrength('abc').score).toBeLessThanOrEqual(1);
    expect(passwordStrength('Swachh-Safar-2026!').score).toBe(4);
  });
});

describe('validateRegistration', () => {
  it('returns field errors and the normalized email', () => {
    expect(validateRegistration({ email: 'bad', password: 'short' })).toMatchObject({
      valid: false, errors: { email: expect.any(String), password: expect.any(String) },
    });
    expect(validateRegistration({ email: ' A@Example.com', password: 'safar2026x' })).toEqual({
      valid: true, errors: {}, email: 'a@example.com',
    });
  });
});
