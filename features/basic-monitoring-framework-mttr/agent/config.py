"""Configuration for the monitoring agent."""

from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(ValueError):
    """Raised when required runtime configuration is missing or invalid."""


@dataclass(frozen=True, slots=True)
class AgentConfig:
    """Typed runtime configuration for the monitoring agent."""

    health_report_bucket: str = "hokusai-health-reports-development"
    health_report_key: str = "latest/development/report.md"
    aws_region: str = "us-east-1"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = "openai/gpt-4.1-mini"
    openrouter_timeout_seconds: float = 60.0
    openrouter_api_key: str | None = None

    @classmethod
    def from_env(cls) -> AgentConfig:
        """Build config from environment variables."""
        timeout_raw = os.getenv("OPENROUTER_TIMEOUT_SECONDS", "60")
        try:
            timeout = float(timeout_raw)
        except ValueError as exc:
            msg = "OPENROUTER_TIMEOUT_SECONDS must be a number."
            raise ConfigError(msg) from exc
        if timeout <= 0:
            raise ConfigError("OPENROUTER_TIMEOUT_SECONDS must be greater than zero.")

        return cls(
            health_report_bucket=os.getenv(
                "HEALTH_REPORT_BUCKET", "hokusai-health-reports-development"
            ),
            health_report_key=os.getenv("HEALTH_REPORT_KEY", "latest/development/report.md"),
            aws_region=os.getenv("AWS_REGION", "us-east-1"),
            openrouter_base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            openrouter_model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4.1-mini"),
            openrouter_timeout_seconds=timeout,
            openrouter_api_key=os.getenv("OPENROUTER_API_KEY"),
        )

    def require_openrouter_api_key(self) -> str:
        """Return the OpenRouter API key or raise a config error."""
        if not self.openrouter_api_key:
            raise ConfigError("Missing required environment variable: OPENROUTER_API_KEY")
        return self.openrouter_api_key
