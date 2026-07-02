import { createPublicKey, createVerify } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

const CERT_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;
const SUPPORTED_SIGNATURE_VERSIONS = new Set(['1', '2']);

interface SnsMessageBase {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
}

export interface SnsNotification extends SnsMessageBase {
  Type: 'Notification';
  UnsubscribeURL?: string;
}

export interface SnsSubscriptionConfirmation extends SnsMessageBase {
  Type: 'SubscriptionConfirmation';
  SubscribeURL: string;
  Token: string;
}

export type SnsMessage = SnsNotification | SnsSubscriptionConfirmation;

/**
 * Thrown when the body is a structurally valid SNS envelope but of a type this
 * handler does not act on (e.g. `UnsubscribeConfirmation`). Callers should
 * acknowledge these with 200 and ignore them rather than returning 400, so SNS
 * does not treat them as delivery failures and retry.
 */
export class UnsupportedSnsMessageError extends Error {
  constructor(public readonly messageType: string) {
    super(`Unsupported SNS message type: ${messageType}`);
    this.name = 'UnsupportedSnsMessageError';
  }
}

export interface CloudWatchAlarmMessage {
  AlarmArn: string;
  AlarmName: string;
  NewStateValue: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  StateChangeTime: string;
  [key: string]: unknown;
}

export interface SnsVerificationOptions {
  cache?: Map<string, string>;
  certTimeoutMs?: number;
  fetchCert?: (url: string, signal: AbortSignal) => Promise<string>;
}

export interface SubscriptionConfirmationOptions {
  timeoutMs?: number;
  confirmGet?: (url: string, signal: AbortSignal) => Promise<void>;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireBaseMessage(record: JsonRecord): SnsMessageBase {
  const Type = readString(record, 'Type');
  const MessageId = readString(record, 'MessageId');
  const TopicArn = readString(record, 'TopicArn');
  const Message = readString(record, 'Message');
  const Timestamp = readString(record, 'Timestamp');
  const SignatureVersion = readString(record, 'SignatureVersion');
  const Signature = readString(record, 'Signature');
  const SigningCertURL = readString(record, 'SigningCertURL');

  if (
    !Type ||
    !MessageId ||
    !TopicArn ||
    !Message ||
    !Timestamp ||
    !SignatureVersion ||
    !Signature ||
    !SigningCertURL
  ) {
    throw new Error('Invalid SNS message');
  }

  const message: SnsMessageBase = {
    Type,
    MessageId,
    TopicArn,
    Message,
    Timestamp,
    SignatureVersion,
    Signature,
    SigningCertURL,
  };
  const subject = readString(record, 'Subject');
  if (subject) {
    message.Subject = subject;
  }
  return message;
}

export function parseSnsMessage(body: unknown): SnsMessage {
  const parsed =
    typeof body === 'string'
      ? (() => {
          try {
            return JSON.parse(body) as unknown;
          } catch {
            throw new Error('Invalid SNS JSON');
          }
        })()
      : body;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error('Invalid SNS message');
  }

  const base = requireBaseMessage(record);

  if (base.Type === 'Notification') {
    const message: SnsNotification = {
      ...base,
      Type: 'Notification',
    };
    const unsubscribeUrl = readString(record, 'UnsubscribeURL');
    if (unsubscribeUrl) {
      message.UnsubscribeURL = unsubscribeUrl;
    }
    return message;
  }

  if (base.Type === 'SubscriptionConfirmation') {
    const SubscribeURL = readString(record, 'SubscribeURL');
    const Token = readString(record, 'Token');
    if (!SubscribeURL || !Token) {
      throw new Error('Invalid SNS subscription confirmation');
    }
    return {
      ...base,
      Type: 'SubscriptionConfirmation',
      SubscribeURL,
      Token,
    };
  }

  throw new UnsupportedSnsMessageError(base.Type);
}

export function buildCanonicalSnsMessage(message: SnsMessage): string {
  const fields =
    message.Type === 'Notification'
      ? [
          ['Message', message.Message],
          ['MessageId', message.MessageId],
          ...(message.Subject ? [['Subject', message.Subject] as const] : []),
          ['Timestamp', message.Timestamp],
          ['TopicArn', message.TopicArn],
          ['Type', message.Type],
        ]
      : [
          ['Message', message.Message],
          ['MessageId', message.MessageId],
          ['SubscribeURL', message.SubscribeURL],
          ['Timestamp', message.Timestamp],
          ['Token', message.Token],
          ['TopicArn', message.TopicArn],
          ['Type', message.Type],
        ];

  return `${fields.map(([key, value]) => `${key}\n${value}`).join('\n')}\n`;
}

export function isAllowedSigningCertUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && CERT_HOST_RE.test(url.hostname);
}

async function defaultFetchCert(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch SNS signing cert: ${response.status}`);
  }
  return response.text();
}

async function defaultConfirmGet(url: string, signal: AbortSignal): Promise<void> {
  await fetch(url, { method: 'GET', signal });
}

function verifySignature(
  message: SnsMessage,
  pem: string
): boolean {
  const algorithm =
    message.SignatureVersion === '1'
      ? 'RSA-SHA1'
      : message.SignatureVersion === '2'
        ? 'RSA-SHA256'
        : null;
  if (!algorithm) {
    return false;
  }

  const verifier = createVerify(algorithm);
  verifier.update(buildCanonicalSnsMessage(message), 'utf8');
  verifier.end();
  return verifier.verify(createPublicKey(pem), Buffer.from(message.Signature, 'base64'));
}

export async function verifySnsMessageSignature(
  message: SnsMessage,
  options: SnsVerificationOptions = {}
): Promise<boolean> {
  if (!SUPPORTED_SIGNATURE_VERSIONS.has(message.SignatureVersion)) {
    return false;
  }
  if (!isAllowedSigningCertUrl(message.SigningCertURL)) {
    return false;
  }

  const cache = options.cache;
  const cached = cache?.get(message.SigningCertURL);
  if (cached) {
    return verifySignature(message, cached);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.certTimeoutMs ?? 5000);
  try {
    const pem = await (options.fetchCert ?? defaultFetchCert)(message.SigningCertURL, controller.signal);
    cache?.set(message.SigningCertURL, pem);
    return verifySignature(message, pem);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function confirmSnsSubscription(
  subscribeUrl: string,
  options: SubscriptionConfirmationOptions = {}
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    await (options.confirmGet ?? defaultConfirmGet)(subscribeUrl, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseCloudWatchAlarmMessage(message: string): CloudWatchAlarmMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) {
    return null;
  }

  const AlarmArn = readString(record, 'AlarmArn');
  const AlarmName = readString(record, 'AlarmName');
  const NewStateValue = readString(record, 'NewStateValue');
  const StateChangeTime = readString(record, 'StateChangeTime');

  if (
    !AlarmArn ||
    !AlarmName ||
    !StateChangeTime ||
    (NewStateValue !== 'ALARM' && NewStateValue !== 'OK' && NewStateValue !== 'INSUFFICIENT_DATA')
  ) {
    return null;
  }

  return {
    ...record,
    AlarmArn,
    AlarmName,
    NewStateValue,
    StateChangeTime,
  };
}
