"""Classify stage orchestration."""

from __future__ import annotations

import json
from importlib import resources

from pydantic import ValidationError

from agent.config import AgentConfig
from agent.health_report import HealthReportError, fetch_latest_report
from agent.models import ClassificationResult, StageResult
from agent.openrouter_client import OpenRouterClient, OpenRouterError

CORRECTION_PROMPT = (
    "Your previous response was invalid. Return valid JSON only, with no markdown fences, "
    "and match the required schema exactly."
)


def load_prompt_template() -> str:
    """Load the classify prompt template from package data."""
    return resources.files("agent.prompts").joinpath("classify.md").read_text(encoding="utf-8")


def render_prompt(template: str, report: str) -> str:
    """Inject the health report into the prompt template once."""
    return template.replace("{{HEALTH_REPORT}}", report, 1)


def strip_markdown_fences(content: str) -> str:
    """Strip a single layer of fenced markdown if present."""
    stripped = content.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3:
            return "\n".join(lines[1:-1]).strip()
    return stripped


def _parse_and_validate(content: str) -> ClassificationResult:
    cleaned = strip_markdown_fences(content)
    payload = json.loads(cleaned)
    return ClassificationResult.model_validate(payload)


def _request_classification(
    client: OpenRouterClient,
    prompt: str,
    retry_instruction: str | None = None,
) -> ClassificationResult:
    messages = [{"role": "user", "content": prompt}]
    if retry_instruction:
        messages.append({"role": "user", "content": retry_instruction})
    response_text = client.complete(messages)
    return _parse_and_validate(response_text)


async def run_classify_stage(
    config: AgentConfig | None = None,
    *,
    s3_client: object | None = None,
    openrouter_client: OpenRouterClient | None = None,
) -> StageResult[ClassificationResult]:
    """Run the Classify stage and return a structured stage result."""
    resolved_config = config or AgentConfig.from_env()
    try:
        report = fetch_latest_report(resolved_config, s3_client=s3_client)
        template = load_prompt_template()
        prompt = render_prompt(template, report)
        client = openrouter_client or OpenRouterClient(resolved_config)
        try:
            classification = _request_classification(client, prompt)
        except (json.JSONDecodeError, ValidationError):
            classification = _request_classification(client, prompt, CORRECTION_PROMPT)
        return StageResult(stage="Classify", status="success", output=classification)
    except (
        HealthReportError,
        OpenRouterError,
        json.JSONDecodeError,
        ValidationError,
        ValueError,
    ) as exc:
        return StageResult(stage="Classify", status="failed", error=str(exc))
