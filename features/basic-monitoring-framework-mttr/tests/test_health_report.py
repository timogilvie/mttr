from __future__ import annotations

from io import BytesIO

import pytest
from botocore.exceptions import ClientError, NoCredentialsError

from agent.config import AgentConfig
from agent.health_report import (
    HealthReportEmptyError,
    HealthReportFetchError,
    HealthReportNotFoundError,
    fetch_latest_report,
)


class StubS3Client:
    def __init__(self, body: bytes) -> None:
        self.body = body

    def get_object(self, **_: str) -> dict[str, BytesIO]:
        return {"Body": BytesIO(self.body)}


def test_fetch_latest_report_success(tmp_path) -> None:
    _ = tmp_path
    config = AgentConfig()
    client = StubS3Client(b"report body")
    assert fetch_latest_report(config, s3_client=client) == "report body"


def test_fetch_latest_report_missing_key() -> None:
    config = AgentConfig()

    class MissingKeyClient:
        def get_object(self, **_: str) -> None:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")

    with pytest.raises(HealthReportNotFoundError):
        fetch_latest_report(config, s3_client=MissingKeyClient())


def test_fetch_latest_report_access_denied() -> None:
    config = AgentConfig()

    class AccessDeniedClient:
        def get_object(self, **_: str) -> None:
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")

    with pytest.raises(HealthReportFetchError) as exc_info:
        fetch_latest_report(config, s3_client=AccessDeniedClient())

    assert "access denied" in str(exc_info.value).lower()
    assert "OPENROUTER" not in str(exc_info.value)


def test_fetch_latest_report_missing_credentials() -> None:
    config = AgentConfig()

    class NoCredentialsClient:
        def get_object(self, **_: str) -> None:
            raise NoCredentialsError()

    with pytest.raises(HealthReportFetchError) as exc_info:
        fetch_latest_report(config, s3_client=NoCredentialsClient())

    assert "credentials" in str(exc_info.value).lower()


def test_fetch_latest_report_empty_body() -> None:
    config = AgentConfig()
    client = StubS3Client(b"   ")
    with pytest.raises(HealthReportEmptyError):
        fetch_latest_report(config, s3_client=client)
