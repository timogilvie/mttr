import { createVerify } from 'node:crypto';

export type SnsMessageType = 'SubscriptionConfirmation' | 'Notification' | 'UnsubscribeConfirmation';

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  // Missing/malformed signature fields are a verification failure (403), not
  // a body-shape failure (400) - see `verifySnsSignature` - so these stay
  // optional rather than required.
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

// AWS publishes SNS signing certs (and SubscribeURL/UnsubscribeURL confirmation
// endpoints) only from regional `sns.<region>.amazonaws.com` hosts. Anchoring
// with `$` and requiring `https:` blocks SSRF via a lookalike host
// (e.g. `sns.us-east-1.amazonaws.com.evil.com`).
const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

export function isAllowedSnsUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && SNS_HOST_RE.test(parsed.hostname);
}

const CONFIRMATION_TYPES = new Set<string>(['SubscriptionConfirmation', 'UnsubscribeConfirmation']);

/**
 * Builds the canonical string SNS signs over. Field order and presence rules
 * come from the AWS SNS message signature spec: `Message`, `MessageId`,
 * (`Subject` only if present, `Notification` only), `SubscribeURL`/`Token`
 * (confirmation types only), `Timestamp`, `TopicArn`, `Type` - each emitted as
 * `key\nvalue\n`.
 */
export function buildCanonicalString(msg: SnsMessage): string {
  const fields: Array<[string, string | undefined]> = CONFIRMATION_TYPES.has(msg.Type)
    ? [
        ['Message', msg.Message],
        ['MessageId', msg.MessageId],
        ['SubscribeURL', msg.SubscribeURL],
        ['Timestamp', msg.Timestamp],
        ['Token', msg.Token],
        ['TopicArn', msg.TopicArn],
        ['Type', msg.Type],
      ]
    : [
        ['Message', msg.Message],
        ['MessageId', msg.MessageId],
        ['Subject', msg.Subject],
        ['Timestamp', msg.Timestamp],
        ['TopicArn', msg.TopicArn],
        ['Type', msg.Type],
      ];

  return fields
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}\n${value}\n`)
    .join('');
}

const SIGNATURE_ALGORITHM_BY_VERSION: Record<string, string> = {
  '1': 'RSA-SHA1',
  '2': 'RSA-SHA256',
};

// In-process cache of fetched cert PEMs, keyed by SigningCertURL, so repeated
// notifications from the same SNS topic don't trigger a network fetch per message.
const certCache = new Map<string, Promise<string>>();

export function clearSnsCertCache(): void {
  certCache.clear();
}

async function getCert(url: string, fetchCert: (url: string) => Promise<string>): Promise<string> {
  const cached = certCache.get(url);
  if (cached) {
    return cached;
  }
  const pending = fetchCert(url);
  certCache.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    certCache.delete(url);
    throw error;
  }
}

export interface VerifySnsSignatureOptions {
  fetchCert: (url: string) => Promise<string>;
}

/**
 * Verifies an SNS message signature against its SigningCertURL. Returns false
 * (never throws) for any failure - unsupported SignatureVersion, disallowed
 * cert host, cert fetch failure, or signature mismatch - so callers can
 * uniformly respond 403 without special-casing errors.
 */
export async function verifySnsSignature(
  msg: SnsMessage,
  { fetchCert }: VerifySnsSignatureOptions
): Promise<boolean> {
  const algorithm = msg.SignatureVersion ? SIGNATURE_ALGORITHM_BY_VERSION[msg.SignatureVersion] : undefined;
  if (!algorithm || !msg.Signature || !msg.SigningCertURL) {
    return false;
  }
  // Host allowlist must be enforced before any fetch of the cert URL.
  if (!isAllowedSnsUrl(msg.SigningCertURL)) {
    return false;
  }

  try {
    const cert = await getCert(msg.SigningCertURL, fetchCert);
    const canonicalString = buildCanonicalString(msg);
    const verifier = createVerify(algorithm);
    verifier.update(canonicalString, 'utf8');
    verifier.end();
    return verifier.verify(cert, msg.Signature, 'base64');
  } catch {
    return false;
  }
}
