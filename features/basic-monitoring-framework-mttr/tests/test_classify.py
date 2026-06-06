from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.config import AgentConfig
from agent.models import Severity
from agent.openrouter_client import OpenRouterClient
from agent.stages.classify import (
    CORRECTION_PROMPT,
    load_prompt_template,
    render_prompt,
    run_classify_stage,
    strip_markdown_fences,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "sample_report.md"
NO_INCIDENT_JSON = json.dumps(
    {
        "summary": "No actionable incidents detected.",
        "overall_severity": "NONE",
        "incidents": [],
        "findings": [],
    }
)


class StubS3Client:
    def __init__(self, text: str) -> None:
        self.text = text.encode("utf-8")

    def get_object(self, **_: str) -> dict[str, object]:
        class Body:
            def __init__(self, payload: bytes) -> None:
                self.payload = payload

            def read(self) -> bytes:
                return self.payload

        return {"Body": Body(self.text)}


class StubOpenRouterClient(OpenRouterClient):
    def __init__(self, responses: list[str]) -> None:
        super().__init__(AgentConfig(openrouter_api_key="test-key"))
        self.responses = responses
        self.calls: list[list[dict[str, str]]] = []

    def complete(self, messages: list[dict[str, str]], model: str | None = None) -> str:
        self.calls.append(messages)
        return self.responses.pop(0)


def test_render_prompt_replaces_placeholder_once() -> None:
    template = load_prompt_template()
    report = "report {with braces} {{HEALTH_REPORT}}"
    rendered = render_prompt(template, report)
    assert "You are the Classify stage" in rendered
    assert "{{HEALTH_REPORT}}" in rendered
    assert report in rendered
    assert rendered.count("{{HEALTH_REPORT}}") == 1


@pytest.mark.asyncio
async def test_run_classify_stage_healthy_report() -> None:
    report = FIXTURE_PATH.read_text(encoding="utf-8")
    stage_result = await run_classify_stage(
        AgentConfig(openrouter_api_key="test-key"),
        s3_client=StubS3Client(report),
        openrouter_client=StubOpenRouterClient([NO_INCIDENT_JSON]),
    )
    assert stage_result.status == "success"
    assert stage_result.output is not None
    assert stage_result.output.overall_severity is Severity.NONE
    assert stage_result.output.incidents == []


@pytest.mark.asyncio
async def test_markdown_fenced_json_is_accepted() -> None:
    report = FIXTURE_PATH.read_text(encoding="utf-8")
    fenced = f"```json\n{NO_INCIDENT_JSON}\n```"
    result = await run_classify_stage(
        AgentConfig(openrouter_api_key="test-key"),
        s3_client=StubS3Client(report),
        openrouter_client=StubOpenRouterClient([fenced]),
    )
    assert result.status == "success"
    assert result.output is not None
    assert result.output.overall_severity is Severity.NONE


@pytest.mark.asyncio
async def test_invalid_first_response_retries_once() -> None:
    report = FIXTURE_PATH.read_text(encoding="utf-8")
    client = StubOpenRouterClient(["not json", NO_INCIDENT_JSON])
    result = await run_classify_stage(
        AgentConfig(openrouter_api_key="test-key"),
        s3_client=StubS3Client(report),
        openrouter_client=client,
    )
    assert result.status == "success"
    assert len(client.calls) == 2
    assert client.calls[1][-1]["content"] == CORRECTION_PROMPT


@pytest.mark.asyncio
async def test_two_invalid_responses_return_failed_result() -> None:
    report = FIXTURE_PATH.read_text(encoding="utf-8")
    client = StubOpenRouterClient(["not json", "still not json"])
    result = await run_classify_stage(
        AgentConfig(openrouter_api_key="test-key"),
        s3_client=StubS3Client(report),
        openrouter_client=client,
    )
    assert result.status == "failed"
    assert result.error is not None


@pytest.mark.asyncio
async def test_schema_validation_error_triggers_retry() -> None:
    report = FIXTURE_PATH.read_text(encoding="utf-8")
    invalid = json.dumps(
        {
            "summary": "bad",
            "overall_severity": "NONE",
            "incidents": [],
            "findings": [
                {
                    "title": "bad",
                    "classification": "UNKNOWN",
                    "severity": "LOW",
                    "confidence": 1.5,
                    "affected_services": [],
                    "evidence": [],
                    "reason_not_incident": "bad",
                }
            ],
        }
    )
    client = StubOpenRouterClient([invalid, NO_INCIDENT_JSON])
    result = await run_classify_stage(
        AgentConfig(openrouter_api_key="test-key"),
        s3_client=StubS3Client(report),
        openrouter_client=client,
    )
    assert result.status == "success"
    assert len(client.calls) == 2


def test_strip_markdown_fences() -> None:
    assert strip_markdown_fences("```json\n{}\n```") == "{}"
