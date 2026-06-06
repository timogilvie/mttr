export class LlmError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'LlmError';
  }
}

interface OpenRouterMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  temperature: number;
  response_format: { type: string };
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export async function callOpenRouter(
  prompt: string,
  apiKey: string,
  model: string,
  baseUrl: string,
  timeoutMs: number
): Promise<string> {
  const url = `${baseUrl}/chat/completions`;

  const requestBody: OpenRouterRequest = {
    model,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => 'Unable to read response body');
      const snippet = bodyText.slice(0, 200);
      throw new LlmError(
        `OpenRouter returned status ${response.status}: ${snippet}`,
        { status: response.status, body: snippet }
      );
    }

    const data = (await response.json()) as OpenRouterResponse;

    if (!data.choices || data.choices.length === 0) {
      throw new LlmError('OpenRouter response missing choices array');
    }

    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new LlmError('OpenRouter response missing message content');
    }

    return content;
  } catch (error) {
    if (error instanceof LlmError) {
      throw error;
    }

    if ((error as { name?: string }).name === 'AbortError') {
      throw new LlmError(`OpenRouter request timeout after ${timeoutMs}ms`, error);
    }

    throw new LlmError(
      `Failed to call OpenRouter: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
