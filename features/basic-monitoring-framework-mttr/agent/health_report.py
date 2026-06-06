"""S3 access for the CloudWatch health report."""

from __future__ import annotations

from typing import Any, Protocol, cast

import boto3
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

from agent.config import AgentConfig


class HealthReportError(RuntimeError):
    """Base health-report error."""


class HealthReportNotFoundError(HealthReportError):
    """Raised when the configured report object cannot be found."""


class HealthReportEmptyError(HealthReportError):
    """Raised when the fetched report body is empty."""


class HealthReportFetchError(HealthReportError):
    """Raised when the report cannot be fetched from S3."""


class BodyReader(Protocol):
    def read(self) -> bytes:
        """Return the body bytes."""


def _object_ref(config: AgentConfig) -> str:
    return f"s3://{config.health_report_bucket}/{config.health_report_key}"


def fetch_latest_report(config: AgentConfig, s3_client: Any | None = None) -> str:
    """Fetch and decode the latest health report from S3."""
    client = s3_client or boto3.client("s3", region_name=config.aws_region)
    object_ref = _object_ref(config)

    try:
        response = client.get_object(
            Bucket=config.health_report_bucket,
            Key=config.health_report_key,
        )
        body_reader = cast(BodyReader, response["Body"])
        body = body_reader.read()
    except NoCredentialsError as exc:
        raise HealthReportFetchError(
            f"Unable to read {object_ref}: AWS credentials are missing."
        ) from exc
    except ClientError as exc:
        error_code = exc.response.get("Error", {}).get("Code", "")
        if error_code in {"NoSuchKey", "NoSuchBucket", "404"}:
            raise HealthReportNotFoundError(f"Health report not found: {object_ref}") from exc
        if error_code in {"AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"}:
            raise HealthReportFetchError(
                f"Unable to read {object_ref}: access denied."
            ) from exc
        raise HealthReportFetchError(
            f"Unable to read {object_ref}: {error_code or 'ClientError'}"
        ) from exc
    except BotoCoreError as exc:
        raise HealthReportFetchError(f"Unable to read {object_ref}: AWS client failure.") from exc

    report = body.decode("utf-8").strip()
    if not report:
        raise HealthReportEmptyError(f"Fetched empty health report from {object_ref}")
    return report
