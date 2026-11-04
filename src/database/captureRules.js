// Validation shared by every device-captured record. Mirrors backend schemas/common.py (Captured)
// and services/journeys.py check_capture_window, so a record accepted locally is one the server can accept.
import { istDate } from '../utils/businessDate.js';
import { LocalRuleError } from './errors.js';

const AWARE_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const COACH_RE = /^[A-Z0-9 ]{1,10}$/;
export const MOBILE_RE = /^[6-9][0-9]{9}$/;
export const PNR_RE = /^[0-9]{10}$/;
const MAX_CLOCK_SKEW_MS = 10 * 60_000;

export function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new LocalRuleError('invalid_value', `${field} must be a UUID.`);
  return value;
}

export function requireInt(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new LocalRuleError('invalid_value', `${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function optionalText(value, field, max, min = 0) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (text.length < min || text.length > max) throw new LocalRuleError('invalid_value', `${field} must be ${min}–${max} characters.`);
  return text;
}

export function requireText(value, field, min, max) {
  const text = optionalText(value, field, max, min);
  if (text == null) throw new LocalRuleError('invalid_value', `${field} is required.`);
  return text;
}

// Timezone-aware device timestamp, not in the future. Returns its Asia/Kolkata business date.
export function requireDeviceTimestamp(value, nowMs) {
  if (typeof value !== 'string' || !AWARE_TS.test(value)) {
    throw new LocalRuleError('invalid_value', 'device_timestamp must include a timezone offset.');
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new LocalRuleError('invalid_value', 'device_timestamp is not a valid time.');
  if (ms > nowMs + MAX_CLOCK_SKEW_MS) throw new LocalRuleError('clock_skew', 'The device clock is ahead of the current time.');
  return istDate(ms);
}

export function requireGps(p) {
  const { latitude, longitude, gps_accuracy_m: acc } = p;
  if (typeof latitude !== 'number' || latitude < -90 || latitude > 90 || typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
    throw new LocalRuleError('gps_required', 'A GPS location is required.');
  }
  if (acc != null && (typeof acc !== 'number' || acc < 0 || acc > 10000)) throw new LocalRuleError('invalid_value', 'gps_accuracy_m must be 0–10000.');
  return { latitude, longitude, gps_accuracy_m: acc ?? null };
}

// The record must belong to a live journey and be captured during its business dates.
export function requireCaptureWindow(journey, capturedOn) {
  if (!journey) throw new LocalRuleError('journey_not_found', 'This journey is not available on this device.');
  if (journey.status === 'cancelled') throw new LocalRuleError('journey_cancelled', 'This journey is cancelled.');
  if (capturedOn < journey.journey_date || capturedOn > journey.end_date) {
    throw new LocalRuleError('outside_journey', 'The record was not captured during the journey dates (Asia/Kolkata).');
  }
}
