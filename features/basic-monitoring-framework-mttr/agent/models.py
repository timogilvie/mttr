"""Shared models for monitoring-agent stages."""

from __future__ import annotations

from enum import Enum
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field


class Severity(str, Enum):
    NONE = "NONE"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class Classification(str, Enum):
    DEPLOYMENT_REGRESSION = "DEPLOYMENT_REGRESSION"
    RESOURCE_EXHAUSTION = "RESOURCE_EXHAUSTION"
    AUTH_FAILURE = "AUTH_FAILURE"
    DATABASE_DEGRADATION = "DATABASE_DEGRADATION"
    EXTERNAL_DEPENDENCY_FAILURE = "EXTERNAL_DEPENDENCY_FAILURE"
    CONFIGURATION_DRIFT = "CONFIGURATION_DRIFT"
    NETWORK_CONNECTIVITY = "NETWORK_CONNECTIVITY"
    TRAFFIC_ANOMALY = "TRAFFIC_ANOMALY"
    APPLICATION_ERROR = "APPLICATION_ERROR"
    BACKGROUND_JOB_FAILURE = "BACKGROUND_JOB_FAILURE"
    DATA_PIPELINE_FAILURE = "DATA_PIPELINE_FAILURE"
    STORAGE_DEGRADATION = "STORAGE_DEGRADATION"
    CACHE_DEGRADATION = "CACHE_DEGRADATION"
    RATE_LIMITING = "RATE_LIMITING"
    SECURITY_EVENT = "SECURITY_EVENT"
    OBSERVABILITY_FAILURE = "OBSERVABILITY_FAILURE"
    UNKNOWN = "UNKNOWN"


class Signals(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alarms: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)
    logs: list[str] = Field(default_factory=list)


class InvestigationPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    priority: int
    estimated_user_impact: str
    first_actions: list[str] = Field(default_factory=list)
    questions_to_answer: list[str] = Field(default_factory=list)
    suggested_cloudwatch_queries: list[str] = Field(default_factory=list)


class Incident(BaseModel):
    model_config = ConfigDict(extra="forbid")

    incident_id: str
    title: str
    classification: Classification
    severity: Severity
    confidence: float = Field(ge=0.0, le=1.0)
    affected_services: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    signals: Signals
    suspected_causes: list[str] = Field(default_factory=list)
    investigation_plan: InvestigationPlan
    recommended_next_stage: Literal["INVESTIGATE"]


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    classification: Classification
    severity: Severity
    confidence: float = Field(ge=0.0, le=1.0)
    affected_services: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    reason_not_incident: str


class ClassificationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    overall_severity: Severity
    incidents: list[Incident] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)


StageStatus = Literal["success", "failed", "not_implemented"]

T = TypeVar("T")


class StageResult(BaseModel, Generic[T]):
    model_config = ConfigDict(extra="forbid")

    stage: str
    status: StageStatus
    output: T | None = None
    error: str | None = None

