import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';
import { resolveToolTimeRange } from './types.js';
import { awsRetryConfig } from '../util/awsRetry.js';

export class AlbAccessLogsToolError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'AlbAccessLogsToolError';
  }
}

const STATUS_CLASSES = ['all', '2xx', '3xx', '4xx', '5xx', 'errors'] as const;
type StatusClass = (typeof STATUS_CLASSES)[number];

const DEFAULT_SAMPLE_LIMIT = 10;
const MAX_SAMPLE_LIMIT = 50;
const MAX_BREAKDOWN_ROWS = 25;
const MAX_FILES = 48;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_WINDOW_DAYS = 3;
const MAX_LIST_PAGES_PER_DAY = 10;
// A log file whose name ends at T contains entries from roughly the preceding
// five minutes, so include files stamped slightly after the window end.
const FILE_END_SLACK_MS = 6 * 60 * 1000;

const argsSchema = z.object({
  load_balancer: z.string().min(1),
  status_class: z.enum(STATUS_CLASSES).optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  lookback_minutes: z.number().optional(),
  sample_limit: z.number().optional(),
});

type AlbAccessLogsArgs = z.infer<typeof argsSchema>;

const parametersJsonSchema = {
  type: 'object',
  properties: {
    load_balancer: {
      type: 'string',
      description:
        'ALB name, or the CloudWatch LoadBalancer dimension value of the form "app/<name>/<id>".',
    },
    status_class: {
      type: 'string',
      enum: [...STATUS_CLASSES],
      description:
        'Which responses to break down: a status class, "errors" for 4xx+5xx (default), or "all".',
    },
    lookback_minutes: {
      type: 'number',
      description:
        'Fallback relative lookback in minutes. Ignored when start_time and end_time are supplied or a report window is available.',
    },
    start_time: {
      type: 'string',
      description: 'Optional absolute window start as an ISO timestamp. Must be paired with end_time.',
    },
    end_time: {
      type: 'string',
      description: 'Optional absolute window end as an ISO timestamp. Must be paired with start_time.',
    },
    sample_limit: {
      type: 'number',
      description: `Max sample request entries to return (default ${DEFAULT_SAMPLE_LIMIT}, capped at ${MAX_SAMPLE_LIMIT}).`,
    },
  },
  required: ['load_balancer'],
} as const;

interface AccessLogEntry {
  time: Date;
  elbStatus: string;
  targetStatus: string;
  method: string;
  path: string;
  target: string;
  targetProcessingTime: string;
  errorReason: string;
}

function loadBalancerNameFrom(input: string): string {
  const dimensionMatch = input.match(/^app\/([^/]+)\/[0-9a-f]+$/i);
  return dimensionMatch?.[1] ?? input;
}

function matchesStatusClass(status: string, statusClass: StatusClass): boolean {
  switch (statusClass) {
    case 'all':
      return true;
    case 'errors':
      return status.startsWith('4') || status.startsWith('5');
    default:
      return status.startsWith(statusClass[0] ?? '');
  }
}

/**
 * Split an ALB access-log line into fields. Fields are space-separated;
 * request, user agent, and a few others are double-quoted and may contain
 * spaces (ALB percent-encodes embedded quotes, so no escape handling needed).
 */
export function tokenizeAccessLogLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ') {
      i += 1;
      continue;
    }
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1);
      if (end === -1) {
        tokens.push(line.slice(i + 1));
        break;
      }
      tokens.push(line.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let end = line.indexOf(' ', i);
    if (end === -1) {
      end = line.length;
    }
    tokens.push(line.slice(i, end));
    i = end;
  }
  return tokens;
}

function parsePath(requestField: string): { method: string; path: string } {
  const [method = '-', url = '-'] = requestField.split(' ');
  try {
    return { method, path: new URL(url).pathname };
  } catch {
    return { method, path: url };
  }
}

export function parseAccessLogLine(line: string): AccessLogEntry | null {
  const tokens = tokenizeAccessLogLine(line);
  if (tokens.length < 13) {
    return null;
  }
  const time = new Date(tokens[1] ?? '');
  if (Number.isNaN(time.getTime())) {
    return null;
  }
  const { method, path } = parsePath(tokens[12] ?? '');
  return {
    time,
    elbStatus: tokens[8] ?? '-',
    targetStatus: tokens[9] ?? '-',
    method,
    path,
    target: tokens[4] ?? '-',
    targetProcessingTime: tokens[6] ?? '-',
    errorReason: tokens[24] ?? '-',
  };
}

/** Parse the end-time stamp (e.g. "_20260611T1420Z_") out of a log file key. */
function fileEndTime(key: string): Date | null {
  const match = key.match(/_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z_/);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
}

function dayPrefixes(
  basePrefix: string,
  accountId: string,
  region: string,
  startTime: Date,
  endTime: Date
): { prefixes: string[]; truncated: boolean } {
  const prefixes: string[] = [];
  const day = new Date(Date.UTC(
    startTime.getUTCFullYear(),
    startTime.getUTCMonth(),
    startTime.getUTCDate()
  ));
  let truncated = false;
  while (day.getTime() <= endTime.getTime() + FILE_END_SLACK_MS) {
    if (prefixes.length >= MAX_WINDOW_DAYS) {
      truncated = true;
      break;
    }
    const yyyy = day.getUTCFullYear();
    const mm = String(day.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(day.getUTCDate()).padStart(2, '0');
    prefixes.push(
      `${basePrefix}AWSLogs/${accountId}/elasticloadbalancing/${region}/${yyyy}/${mm}/${dd}/`
    );
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return { prefixes, truncated };
}

interface CandidateFile {
  key: string;
  size: number;
  endTime: Date;
}

async function listCandidateFiles(
  s3: S3Client,
  bucket: string,
  prefixes: string[],
  startTime: Date,
  endTime: Date
): Promise<CandidateFile[]> {
  const files: CandidateFile[] = [];
  for (const prefix of prefixes) {
    let continuationToken: string | undefined;
    let pages = 0;
    do {
      const response = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
      );
      for (const object of response.Contents ?? []) {
        if (!object.Key) {
          continue;
        }
        const end = fileEndTime(object.Key);
        if (!end) {
          continue;
        }
        if (end.getTime() >= startTime.getTime() && end.getTime() <= endTime.getTime() + FILE_END_SLACK_MS) {
          files.push({ key: object.Key, size: object.Size ?? 0, endTime: end });
        }
      }
      continuationToken = response.NextContinuationToken;
      pages += 1;
    } while (continuationToken && pages < MAX_LIST_PAGES_PER_DAY);
  }
  return files.sort((a, b) => a.endTime.getTime() - b.endTime.getTime());
}

interface ScanResult {
  totalInWindow: number;
  matching: AccessLogEntry[];
  filesScanned: number;
  notes: string[];
}

async function scanFiles(
  s3: S3Client,
  bucket: string,
  files: CandidateFile[],
  startTime: Date,
  endTime: Date,
  statusClass: StatusClass,
  deadline: number
): Promise<ScanResult> {
  const result: ScanResult = { totalInWindow: 0, matching: [], filesScanned: 0, notes: [] };
  let bytes = 0;

  for (const file of files) {
    if (result.filesScanned >= MAX_FILES) {
      result.notes.push(`Stopped after ${MAX_FILES} files; coverage of the window is partial.`);
      break;
    }
    if (bytes + file.size > MAX_TOTAL_BYTES) {
      result.notes.push('Stopped at the download size cap; coverage of the window is partial.');
      break;
    }
    if (Date.now() >= deadline) {
      result.notes.push('Stopped at the tool timeout; coverage of the window is partial.');
      break;
    }

    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.key }));
    const body = await object.Body?.transformToByteArray();
    if (!body) {
      continue;
    }
    bytes += file.size;
    result.filesScanned += 1;

    const text = file.key.endsWith('.gz')
      ? gunzipSync(Buffer.from(body)).toString('utf8')
      : Buffer.from(body).toString('utf8');

    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      const entry = parseAccessLogLine(line);
      if (!entry) {
        continue;
      }
      if (entry.time.getTime() < startTime.getTime() || entry.time.getTime() > endTime.getTime()) {
        continue;
      }
      result.totalInWindow += 1;
      if (matchesStatusClass(entry.elbStatus, statusClass)) {
        result.matching.push(entry);
      }
    }
  }

  return result;
}

function formatBreakdown(entries: AccessLogEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = `elb_status=${entry.elbStatus} target_status=${entry.targetStatus} ${entry.method} ${entry.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = rows.slice(0, MAX_BREAKDOWN_ROWS);
  const lines = shown.map(([key, count]) => `  ${key}: ${count}`);
  if (rows.length > shown.length) {
    lines.push(`  …and ${rows.length - shown.length} more distinct status/path combinations.`);
  }
  return lines;
}

function formatSamples(entries: AccessLogEntry[], limit: number): string[] {
  return entries
    .slice(0, limit)
    .map(
      (entry) =>
        `  ${entry.time.toISOString()} elb_status=${entry.elbStatus} target_status=${entry.targetStatus} ` +
        `${entry.method} ${entry.path} target=${entry.target} target_time=${entry.targetProcessingTime}s ` +
        `error_reason=${entry.errorReason}`
    );
}

async function handler(args: AlbAccessLogsArgs, ctx: ToolContext): Promise<string> {
  const statusClass = args.status_class ?? 'errors';
  const sampleLimit =
    args.sample_limit && args.sample_limit > 0
      ? Math.min(Math.floor(args.sample_limit), MAX_SAMPLE_LIMIT)
      : DEFAULT_SAMPLE_LIMIT;
  const { startTime, endTime } = resolveToolTimeRange(
    args.start_time,
    args.end_time,
    args.lookback_minutes,
    ctx
  );
  const deadline = Date.now() + ctx.timeoutMs;

  const lbName = loadBalancerNameFrom(args.load_balancer);
  const elbClient = new ElasticLoadBalancingV2Client({
    region: ctx.region,
    ...awsRetryConfig(ctx.maxAttempts),
  });
  const s3Client = new S3Client({ region: ctx.region, ...awsRetryConfig(ctx.maxAttempts) });

  try {
    const described = await elbClient.send(
      new DescribeLoadBalancersCommand({ Names: [lbName] })
    );
    const loadBalancer = described.LoadBalancers?.[0];
    const arn = loadBalancer?.LoadBalancerArn;
    if (!arn) {
      return `No load balancer found with name "${lbName}".`;
    }
    const accountId = arn.split(':')[4] ?? '';

    const attributes = await elbClient.send(
      new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: arn })
    );
    const attribute = (key: string): string | undefined =>
      attributes.Attributes?.find((a) => a.Key === key)?.Value;

    if (attribute('access_logs.s3.enabled') !== 'true') {
      return (
        `Access logging is DISABLED for load balancer "${lbName}". ` +
        `Per-request status/path/target detail is not available; enable access logging ` +
        `(access_logs.s3.enabled) to capture it for future incidents. This is an observability gap.`
      );
    }

    const bucket = attribute('access_logs.s3.bucket');
    if (!bucket) {
      return `Access logging is enabled for "${lbName}" but no S3 bucket is configured.`;
    }
    const rawPrefix = attribute('access_logs.s3.prefix') ?? '';
    const basePrefix = rawPrefix === '' ? '' : `${rawPrefix.replace(/\/+$/, '')}/`;

    const { prefixes, truncated } = dayPrefixes(basePrefix, accountId, ctx.region, startTime, endTime);
    const files = await listCandidateFiles(s3Client, bucket, prefixes, startTime, endTime);

    const header =
      `ALB access logs for "${lbName}" (s3://${bucket}) in window ` +
      `${startTime.toISOString()}..${endTime.toISOString()}, status filter: ${statusClass}.`;

    if (files.length === 0) {
      return (
        `${header}\nNo access log files found for this window. ` +
        `Either the ALB received no traffic, logging was enabled after the window, or delivery lags behind.`
      );
    }

    const scan = await scanFiles(s3Client, bucket, files, startTime, endTime, statusClass, deadline);
    const lines = [
      header,
      `Scanned ${scan.filesScanned} of ${files.length} candidate file(s); ` +
        `${scan.totalInWindow} request(s) in window, ${scan.matching.length} matching the status filter.`,
    ];
    if (truncated) {
      lines.push(`Window spans more than ${MAX_WINDOW_DAYS} days; only the first ${MAX_WINDOW_DAYS} were scanned.`);
    }
    lines.push(...scan.notes);

    if (scan.matching.length > 0) {
      lines.push('Breakdown by status and path:', ...formatBreakdown(scan.matching));
      lines.push(`Sample entries (up to ${sampleLimit}):`, ...formatSamples(scan.matching, sampleLimit));
    } else {
      lines.push('No requests matched the status filter in this window.');
    }

    return lines.join('\n');
  } catch (error) {
    if (error instanceof AlbAccessLogsToolError) {
      throw error;
    }
    throw new AlbAccessLogsToolError(
      `query_alb_access_logs failed: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    elbClient.destroy();
    s3Client.destroy();
  }
}

export const albAccessLogsTool: ToolDefinition<AlbAccessLogsArgs> = {
  name: 'query_alb_access_logs',
  description:
    'Read-only: read ALB access logs from S3 and break down requests by status code, method, and path. The definitive source for which endpoint returned ELB/target 5xx responses — works even when the application never logged the failing request (e.g. 502/504 from crashed or timed-out tasks).',
  parametersJsonSchema,
  argsSchema,
  handler,
};
