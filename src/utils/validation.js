// Input validation for the registration form. Pure functions, shared by UI and services.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123',
  'iloveyou1', 'admin123', 'welcome1', 'abc12345', 'swachhsafar', 'swachh123',
]);

export function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function validateEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) return 'Email is required.';
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return 'Enter a valid email address.';
  return null;
}

// Rough 0–4 score used for the strength meter. Validation rules below are the hard gate.
export function passwordStrength(password = '') {
  if (!password) return { score: 0, label: '' };
  let score = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
  if (password.length < PASSWORD_MIN_LENGTH || COMMON_PASSWORDS.has(password.toLowerCase())) score = Math.min(score, 1);
  return { score, label: ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

// Passwords are never trimmed: leading/trailing spaces are part of the secret.
export function validatePassword(password) {
  if (!password) return 'Password is required.';
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must include at least one letter and one number.';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'This password is too common. Choose another.';
  return null;
}

export function validateRegistration({ email, password }) {
  const errors = {};
  const emailError = validateEmail(email);
  const passwordError = validatePassword(password);
  if (emailError) errors.email = emailError;
  if (passwordError) errors.password = passwordError;
  return { valid: !emailError && !passwordError, errors, email: normalizeEmail(email) };
}
