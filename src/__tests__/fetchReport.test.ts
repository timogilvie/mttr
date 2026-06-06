import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchReport, ReportFetchError } from '../report/fetchReport.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

vi.mock('@aws-sdk/client-s3');

describe('fetchReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns fixture markdown from mocked S3', async () => {
    const mockReport = '# Test Report\n\nContent';

    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(mockReport));
        controller.close();
      },
    });

    const mockSend = vi.fn().mockResolvedValue({
      Body: {
        transformToWebStream: () => mockStream,
      },
    });

    vi.mocked(S3Client).mockImplementation(() => ({
      send: mockSend,
      destroy: vi.fn(),
    }) as unknown as S3Client);

    const result = await fetchReport(
      's3://test-bucket/path/to/report.md',
      'us-east-1',
      5000
    );

    expect(result).toBe(mockReport);
    expect(mockSend).toHaveBeenCalledWith(
      expect.any(GetObjectCommand),
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      })
    );
  });

  it('errors on invalid URI', async () => {
    await expect(
      fetchReport('https://example.com/report.md', 'us-east-1', 5000)
    ).rejects.toThrow(ReportFetchError);
  });

  it('errors on missing key', async () => {
    await expect(
      fetchReport('s3://bucket-only', 'us-east-1', 5000)
    ).rejects.toThrow(ReportFetchError);
  });

  it('errors on empty bucket', async () => {
    await expect(
      fetchReport('s3:///just-a-key', 'us-east-1', 5000)
    ).rejects.toThrow(ReportFetchError);
  });

  it('errors on NoSuchKey', async () => {
    const mockSend = vi.fn().mockRejectedValue({
      name: 'NoSuchKey',
      message: 'The specified key does not exist.',
    });

    vi.mocked(S3Client).mockImplementation(() => ({
      send: mockSend,
      destroy: vi.fn(),
    }) as unknown as S3Client);

    await expect(
      fetchReport('s3://test-bucket/missing.md', 'us-east-1', 5000)
    ).rejects.toThrow(ReportFetchError);
  });

  it('errors on empty body', async () => {
    const mockSend = vi.fn().mockResolvedValue({
      Body: null,
    });

    vi.mocked(S3Client).mockImplementation(() => ({
      send: mockSend,
      destroy: vi.fn(),
    }) as unknown as S3Client);

    await expect(
      fetchReport('s3://test-bucket/report.md', 'us-east-1', 5000)
    ).rejects.toThrow(ReportFetchError);
  });

  it('errors on timeout', async () => {
    const mockSend = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => {
            const error = new Error('Aborted');
            (error as { name?: string }).name = 'AbortError';
            reject(error);
          }, 100);
        })
    );

    vi.mocked(S3Client).mockImplementation(() => ({
      send: mockSend,
      destroy: vi.fn(),
    }) as unknown as S3Client);

    await expect(
      fetchReport('s3://test-bucket/report.md', 'us-east-1', 50)
    ).rejects.toThrow(ReportFetchError);
  }, 10000);
});
