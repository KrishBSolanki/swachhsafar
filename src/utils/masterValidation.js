// Client-side checks for master-data forms, mirroring the backend Pydantic schemas so mistakes are shown
// before submitting. The server validates again and remains the authority.
// Each validator returns { field: message } for invalid fields; an empty object means valid.

const len = (v) => String(v ?? '').trim().length;
const between = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;
const isInt = (n) => Number.isInteger(n);

// schemas/feedback.py QuestionBankCreate + QuestionIn
export function validateBank(f) {
  const e = {};
  if (len(f.name) < 3 || len(f.name) > 100) e.name = 'Name must be 3–100 characters.';
  if (f.audience !== 'passenger' && f.audience !== 'railway') e.audience = 'Choose passenger or railway.';
  if (!isInt(f.scale_min) || !between(f.scale_min, 0, 10)) e.scale_min = 'Lowest rating must be a whole number 0–10.';
  if (!isInt(f.scale_max) || !between(f.scale_max, 1, 10)) e.scale_max = 'Highest rating must be a whole number 1–10.';
  if (!e.scale_min && !e.scale_max && f.scale_min >= f.scale_max) e.scale_max = 'Highest rating must be greater than the lowest.';
  const qs = f.questions ?? [];
  if (qs.length < 1 || qs.length > 20) e.questions = 'A bank needs 1–20 questions.';
  qs.forEach((q, i) => {
    const n = i + 1;
    if (len(q.text_en) < 3 || len(q.text_en) > 500) e[`q${i}.text_en`] = `Question ${n}: English text must be 3–500 characters.`;
    if (len(q.text_hi) > 500) e[`q${i}.text_hi`] = `Question ${n}: Hindi text must be at most 500 characters.`;
    if (!q.applies_ac && !q.applies_non_ac) e[`q${i}.applies`] = `Question ${n}: must apply to AC, Non-AC or both.`;
    if (q.psi_weight !== '' && q.psi_weight != null && !(Number(q.psi_weight) > 0 && Number(q.psi_weight) <= 100)) {
      e[`q${i}.psi_weight`] = `Question ${n}: PSI weight must be more than 0 and at most 100.`;
    }
  });
  return e;
}

// Request body for POST /feedback/question-banks.
export function bankPayload(f, divisionId) {
  return {
    division_id: divisionId ?? null, audience: f.audience, name: f.name.trim(), scale_min: f.scale_min, scale_max: f.scale_max,
    questions: f.questions.map((q) => ({
      text_en: q.text_en.trim(), text_hi: q.text_hi?.trim() || null, applies_ac: !!q.applies_ac, applies_non_ac: !!q.applies_non_ac,
      required: !!q.required, psi_weight: q.psi_weight === '' || q.psi_weight == null ? null : Number(q.psi_weight),
    })),
  };
}

// schemas/complaints.py DepartmentIn / DepartmentUpdate
export function validateDepartment(f) {
  return len(f.name) < 2 || len(f.name) > 100 ? { name: 'Name must be 2–100 characters.' } : {};
}

// schemas/complaints.py CategoryIn / CategoryUpdate
export function validateCategory(f) {
  const e = {};
  if (len(f.name) < 2 || len(f.name) > 100) e.name = 'Name must be 2–100 characters.';
  if (f.sla_hours !== '' && f.sla_hours != null && !(isInt(Number(f.sla_hours)) && between(Number(f.sla_hours), 1, 24 * 60))) {
    e.sla_hours = 'SLA must be a whole number of hours, 1–1440.';
  }
  if (!isInt(Number(f.sort_order))) e.sort_order = 'Display order must be a whole number.';
  return e;
}

// models/inventory.py Unit; schemas/inventory.py ItemIn / ItemUpdate
export const UNITS = [
  { value: 'nos', label: 'Numbers (nos)' }, { value: 'ltr', label: 'Litres (ltr)' },
  { value: 'ml', label: 'Millilitres (ml)' }, { value: 'kg', label: 'Kilograms (kg)' },
];

export function validateItem(f, { creating }) {
  const e = {};
  if (len(f.name) < 2 || len(f.name) > 100) e.name = 'Name must be 2–100 characters.';
  if (creating && !UNITS.some((u) => u.value === f.unit)) e.unit = 'Choose a unit.';
  if (!between(Number(f.ideal_qty), 0, 1_000_000) || f.ideal_qty === '') e.ideal_qty = 'Ideal quantity must be 0–1,000,000.';
  return e;
}

// schemas/policy.py PolicySettings: every setting, with its type and allowed range.
export const POLICY_FIELDS = [
  { key: 'passenger_pnr_required', type: 'bool', label: 'Passenger PNR required', group: 'Passenger feedback' },
  { key: 'passenger_otp_required', type: 'bool', label: 'Passenger OTP verification required', group: 'Passenger feedback' },
  { key: 'pnr_train_day_mapping', type: 'bool', label: 'PNR train must match journey half (main train first half, linked train second half)', group: 'Passenger feedback' },
  { key: 'pnr_coach_match_required', type: 'bool', label: 'PNR coach must match the feedback coach', group: 'Passenger feedback' },
  { key: 'passenger_feedback_per_coach_day', type: 'int', min: 1, max: 100, nullable: true, label: 'Passenger feedback limit per coach per day', hint: 'Leave empty for no limit', group: 'Passenger feedback' },
  { key: 'railway_feedback_limit_per_journey', type: 'int', min: 0, max: 50, label: 'Railway feedback limit per journey', group: 'Railway feedback' },
  { key: 'attendance_photo_required', type: 'bool', label: 'Attendance photo required', group: 'Attendance and inspection' },
  { key: 'attendance_late_grace_days', type: 'int', min: 0, max: 7, label: 'Late attendance grace (days after journey end)', group: 'Attendance and inspection' },
  { key: 'inspection_photo_required', type: 'bool', label: 'Inspection photo required', group: 'Attendance and inspection' },
  { key: 'complaint_default_sla_hours', type: 'int', min: 1, max: 1440, label: 'Default complaint SLA (hours)', group: 'Complaints' },
];

export function validatePolicy(f) {
  const e = {};
  for (const field of POLICY_FIELDS) {
    const v = f[field.key];
    if (field.type === 'bool') {
      if (typeof v !== 'boolean') e[field.key] = `${field.label}: choose yes or no.`;
    } else if (v === null || v === '' || v === undefined) {
      if (!field.nullable) e[field.key] = `${field.label} is required.`;
    } else if (!isInt(Number(v)) || !between(Number(v), field.min, field.max)) {
      e[field.key] = `${field.label} must be a whole number ${field.min}–${field.max}.`;
    }
  }
  return e;
}

// Request body for PUT /divisions/{id}/policy: exactly the PolicySettings fields (the schema forbids extras).
export function policyPayload(f) {
  return Object.fromEntries(POLICY_FIELDS.map((field) => {
    const v = f[field.key];
    if (field.type === 'bool') return [field.key, !!v];
    return [field.key, v === '' || v == null ? null : Number(v)];
  }));
}
