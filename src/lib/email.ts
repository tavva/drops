// ABOUTME: Email normalisation (lowercase, trim, NFC) and a conservative email-shape regex.
// ABOUTME: Every comparison against stored email addresses must go through normaliseEmail.

export function normaliseEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLikelyEmail(value: string): boolean {
  return EMAIL_SHAPE.test(value);
}
