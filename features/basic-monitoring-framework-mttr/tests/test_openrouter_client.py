from __future__ import annotations

import httpx
import pytest

from agent.config import AgentConfig
from agent.openrouter_client import (
    OpenRouterAPIError,
    OpenRouterClient,
    OpenRouterResponseError,
    OpenRouterTimeoutError,
)


def test_complete_success_and_request_shape() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers["Authorization"]
        captured["json"] = request.read().decode("utf-8")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"summary":"ok","overall_severity":"NONE",'
                                '"incidents":[],"findings":[]}'
                            )
                        }
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    client = OpenRouterClient(
        AgentConfig(openrouter_api_key="secret"),
        http_client=httpx.Client(transport=transport),
    )

    result = client.complete([{"role": "user", "content": "hello"}], model="model-x")

    assert '"overall_severity":"NONE"' in result
    assert captured["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert captured["auth"] == "Bearer secret"
    assert '"model": "model-x"' in str(captured["json"])
    assert '"messages"' in str(captured["json"])


def test_complete_timeout_maps_exception() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timeout", request=request)

    client = OpenRouterClient(
        AgentConfig(openrouter_api_key="secret"),
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(OpenRouterTimeoutError):
        client.complete([{"role": "user", "content": "hello"}])


def test_complete_non_2xx_hides_api_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    client = OpenRouterClient(
        AgentConfig(openrouter_api_key="secret"),
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(OpenRouterAPIError) as exc_info:
        client.complete([{"role": "user", "content": "hello"}])

    assert "401" in str(exc_info.value)
    assert "secret" not in str(exc_info.value)


def test_complete_empty_choices() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": []})

    client = OpenRouterClient(
        AgentConfig(openrouter_api_key="secret"),
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(OpenRouterResponseError):
        client.complete([{"role": "user", "content": "hello"}])
