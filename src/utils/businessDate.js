// Business-date semantics: Indian Railways operations run on Asia/Kolkata calendar dates, whatever the
// device's own timezone is. Mirrors backend app/timeutil.py (today_ist, to_ist_date).

export const BUSINESS_TZ = 'Asia/Kolkata';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

// 'YYYY-MM-DD' in Asia/Kolkata for a Date, epoch ms or timezone-aware ISO string.
export function istDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid timestamp: ${value}`);
  return formatter.format(d);
}

export const todayIst = (now = new Date()) => istDate(now);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toUtcMidnight = (ymd) => {
  if (!DATE_RE.test(ymd)) throw new RangeError(`Expected YYYY-MM-DD, got ${ymd}`);
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
};

// Whole calendar days from `from` to `to` (both YYYY-MM-DD).
export const daysBetween = (from, to) => Math.round((toUtcMidnight(to) - toUtcMidnight(from)) / 86_400_000);

export const addDays = (ymd, n) => new Date(toUtcMidnight(ymd) + n * 86_400_000).toISOString().slice(0, 10);

// 1-based journey day for a business date (backend journey_day_for).
export const journeyDayFor = (journeyDate, on) => daysBetween(journeyDate, on) + 1;

// Journey list state, as the backend derives it (services/journeys.py journey_state).
export function journeyState(journey, today) {
  if (journey.status === 'cancelled') return 'cancelled';
  if (today < journey.journey_date) return 'scheduled';
  if (today > journey.end_date) return 'history';
  return 'active';
}
