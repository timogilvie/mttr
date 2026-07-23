import type { Finding, Incident } from '../types.js';

/**
 * Incident identity used to be a hash of the LLM-authored title, so the same underlying condition
 * re-entered as a brand-new incident every time the model reworded it ("No requests on mlflow",
 * "Low Traffic in mlflow", "mlflow service received no requests" → three incidents). A signal key
 * names the *monitored signal* instead of the occurrence, so those collapse into one.
 *
 * Derivation order, most trustworthy first:
 *   1. `alarm:<name>` when the item carries a CloudWatch alarm — alarm names are globally unique
 *      identifiers we control, so they are deliberately service-independent (the same alarm
 *      attributed to two services is one incident, not two).
 *   2. `<service>|<signal_key>` from the Classify stage's declared `signal_key`.
 *   3. `null`, leaving the caller on the legacy title hash.
 */
export type SignalKeySource = 'alarm' | 'declared';

export interface DerivedSignalKey {
  key: string;
  source: SignalKeySource;
}

/**
 * Pure magnitude words. The Classify prompt forbids them inside `signal_key`; stripping them here
 * defensively is safe because no legitimate signal type is distinguished *only* by magnitude, and
 * it is exactly the drift we saw in production ("...:low" vs "...:high" for one signal).
 */
const MAGNITUDE_TOKENS = new Set([
  'high',
  'low',
  'elevated',
  'increased',
  'decreased',
  'single',
  'spike',
  'none',
  'zero',
  'no',
  'minor',
  'major',
  'sudden',
  'unusual',
  'abnormal',
  'excessive',
  'slight',
  'sustained',
  'repeated',
  'occasional',
]);

const ALARM_PREFIX = 'alarm:';

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalizes a declared signal key: lowercases, collapses separators, and drops magnitude and
 * bare-number tokens so `mlflow:alb-request-count:low` and `mlflow:alb-request-count` are one key.
 * Segment structure (`:`) is preserved so `metric-missing:detector-liveness` stays distinct from
 * `detector-liveness`.
 */
export function normalizeSignalKey(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (lowered.startsWith(ALARM_PREFIX)) {
    // Alarm names are exact identifiers — never rewrite their interior.
    const alarmName = slug(lowered.slice(ALARM_PREFIX.length));
    return alarmName === '' ? '' : `${ALARM_PREFIX}${alarmName}`;
  }

  const segments = lowered
    .split(':')
    .map((segment) =>
      segment
        .split(/[^a-z0-9]+/)
        .filter((token) => token !== '' && !MAGNITUDE_TOKENS.has(token) && !/^\d+$/.test(token))
        .join('-')
    )
    .filter((segment) => segment !== '');

  return segments.join(':');
}

function alarmNames(item: Incident | Finding): string[] {
  if (!('signals' in item) || !item.signals) {
    return [];
  }
  return item.signals.alarms.map((name) => name.trim()).filter((name) => name !== '');
}

function serviceScope(item: Incident | Finding): string {
  const services = item.affected_services
    .map(slug)
    .filter((service) => service !== '')
    .sort();
  return services.length > 0 ? services.join('+') : 'unscoped';
}

/**
 * Derives the stable signal key for a classification item, or `null` when neither an alarm nor a
 * declared `signal_key` is available (callers fall back to the legacy title hash).
 */
export function deriveSignalKey(item: Incident | Finding): DerivedSignalKey | null {
  const alarms = alarmNames(item);
  if (alarms.length > 0) {
    const names = [...new Set(alarms.map(slug))].filter((name) => name !== '').sort();
    if (names.length > 0) {
      return { key: `${ALARM_PREFIX}${names.join('+')}`, source: 'alarm' };
    }
  }

  const declared = item.signal_key ? normalizeSignalKey(item.signal_key) : '';
  if (declared === '') {
    return null;
  }

  // A declared key that already names an alarm is service-independent, same as the alarm path.
  if (declared.startsWith(ALARM_PREFIX)) {
    return { key: declared, source: 'declared' };
  }

  // Declared keys conventionally lead with the service; don't repeat it if they already do.
  const scope = serviceScope(item);
  const key = declared === scope || declared.startsWith(`${scope}:`) ? declared : `${scope}:${declared}`;
  return { key, source: 'declared' };
}
