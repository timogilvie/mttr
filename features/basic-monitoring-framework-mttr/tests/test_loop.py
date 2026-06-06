from __future__ import annotations

import asyncio

import pytest

from agent.loop import STAGES, StageDefinition, run_iteration
from agent.models import StageResult


def test_stages_are_registered_in_order() -> None:
    assert [stage.name for stage in STAGES] == [
        "Classify",
        "Investigate",
        "Mitigate",
        "Restore",
        "Verify",
    ]


@pytest.mark.asyncio
async def test_placeholders_return_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_classify() -> StageResult[None]:
        return StageResult(stage="Classify", status="success")

    monkeypatch.setattr(
        "agent.loop.STAGES", (StageDefinition("Classify", fake_classify), *STAGES[1:])
    )
    results = await run_iteration()
    assert results[1].status == "not_implemented"
    assert results[2].status == "not_implemented"
    assert results[3].status == "not_implemented"
    assert results[4].status == "not_implemented"


@pytest.mark.asyncio
async def test_iteration_dispatches_without_downstream_implementation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_classify() -> StageResult[None]:
        await asyncio.sleep(0)
        return StageResult(stage="Classify", status="success")

    monkeypatch.setattr(
        "agent.loop.STAGES", (StageDefinition("Classify", fake_classify), *STAGES[1:])
    )
    results = await run_iteration()
    assert len(results) == 5
    assert results[0].status == "success"


@pytest.mark.asyncio
async def test_stage_exception_is_captured(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken_stage() -> StageResult[None]:
        raise RuntimeError("boom")

    monkeypatch.setattr(
        "agent.loop.STAGES", (StageDefinition("Classify", broken_stage), *STAGES[1:])
    )
    results = await run_iteration()
    assert results[0].status == "failed"
    assert results[0].error == "boom"
    assert results[1].status == "not_implemented"
