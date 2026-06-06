"""OpenRouter chat-completions client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from agent.config import AgentConfig


class OpenRouterError(RuntimeError):
    """Base OpenRouter client error."""


class OpenRouterTimeoutError(OpenRouterError):
    """Raised when OpenRouter does not respond before the timeout."""


class OpenRouterAPIError(OpenRouterError):
    """Raised for non-2xx API responses or transport failures."""


class OpenRouterResponseError(OpenRouterError):
    """Raised when the API response does not contain assistant content."""


@dataclass(slots=True)
class OpenRouterClient:
    """Minimal client for OpenRouter chat completions."""

    config: AgentConfig
    http_client: httpx.Client | None = None

    def complete(self, messages: list[dict[str, str]], model: str | None = None) -> str:
        """Submit a chat completion request and return assistant text."""
        api_key = self.config.require_openrouter_api_key()
        endpoint = f"{self.config.openrouter_base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": model or self.config.openrouter_model,
            "messages": messages,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        client = self.http_client or httpx.Client(timeout=self.config.openrouter_timeout_seconds)
        owns_client = self.http_client is None

        try:
            response = client.post(endpoint, headers=headers, json=payload)
        except httpx.TimeoutException as exc:
            raise OpenRouterTimeoutError("OpenRouter request timed out.") from exc
        except httpx.HTTPError as exc:
            raise OpenRouterAPIError("OpenRouter request failed due to a network error.") from exc
        finally:
            if owns_client:
                client.close()

        if response.status_code >= 400:
            snippet = response.text[:200]
            raise OpenRouterAPIError(
                f"OpenRouter returned HTTP {response.status_code}: {snippet}"
            )

        data = response.json()
        content = _extract_content(data)
        if not content:
            raise OpenRouterResponseError("OpenRouter response did not include assistant content.")
        return content


def _extract_content(data: dict[str, Any]) -> str | None:
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return None
    message = first_choice.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    return content if isinstance(content, str) else None

