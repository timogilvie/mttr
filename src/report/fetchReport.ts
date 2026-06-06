import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export class ReportFetchError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ReportFetchError';
  }
}

interface S3UriParts {
  bucket: string;
  key: string;
}

function parseS3Uri(uri: string): S3UriParts {
  if (!uri.startsWith('s3://')) {
    throw new ReportFetchError(`Invalid S3 URI: must start with s3://, got: ${uri}`);
  }

  const withoutProtocol = uri.slice(5);
  const slashIndex = withoutProtocol.indexOf('/');

  if (slashIndex === -1) {
    throw new ReportFetchError(`Invalid S3 URI: missing key, got: ${uri}`);
  }

  const bucket = withoutProtocol.slice(0, slashIndex);
  const key = withoutProtocol.slice(slashIndex + 1);

  if (!bucket) {
    throw new ReportFetchError(`Invalid S3 URI: empty bucket, got: ${uri}`);
  }

  if (!key) {
    throw new ReportFetchError(`Invalid S3 URI: empty key, got: ${uri}`);
  }

  return { bucket, key };
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let result = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchReport(s3Uri: string, region: string, timeoutMs: number): Promise<string> {
  const { bucket, key } = parseS3Uri(s3Uri);

  const client = new S3Client({ region });
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const response = await client.send(command, {
      abortSignal: abortController.signal,
    });

    if (!response.Body) {
      throw new ReportFetchError('S3 response missing body');
    }

    const bodyStream = response.Body.transformToWebStream();
    const reportText = await streamToString(bodyStream);

    if (!reportText || reportText.trim() === '') {
      throw new ReportFetchError('S3 response body is empty');
    }

    return reportText;
  } catch (error) {
    if (error instanceof ReportFetchError) {
      throw error;
    }

    if ((error as { name?: string }).name === 'AbortError') {
      throw new ReportFetchError(`S3 fetch timeout after ${timeoutMs}ms`, error);
    }

    if ((error as { name?: string }).name === 'NoSuchKey') {
      throw new ReportFetchError(`S3 object not found: ${s3Uri}`, error);
    }

    throw new ReportFetchError(
      `Failed to fetch report from S3: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    clearTimeout(timeoutId);
    client.destroy();
  }
}
