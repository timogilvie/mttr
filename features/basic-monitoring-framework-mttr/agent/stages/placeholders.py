"""Placeholder implementations for future monitoring stages."""

from __future__ import annotations

from agent.models import StageResult


async def investigate_stage() -> StageResult[None]:
    return StageResult(stage="Investigate", status="not_implemented")


async def mitigate_stage() -> StageResult[None]:
    return StageResult(stage="Mitigate", status="not_implemented")


async def restore_stage() -> StageResult[None]:
    return StageResult(stage="Restore", status="not_implemented")


async def verify_stage() -> StageResult[None]:
    return StageResult(stage="Verify", status="not_implemented")

