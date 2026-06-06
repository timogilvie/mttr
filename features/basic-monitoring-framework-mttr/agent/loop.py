"""Non-blocking monitoring loop scaffold."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, cast

from agent.models import StageResult
from agent.stages.classify import run_classify_stage
from agent.stages.placeholders import (
    investigate_stage,
    mitigate_stage,
    restore_stage,
    verify_stage,
)

StageRunner = Callable[..., Awaitable[StageResult[Any]]]


@dataclass(frozen=True, slots=True)
class StageDefinition:
    name: str
    runner: StageRunner


STAGES: tuple[StageDefinition, ...] = (
    StageDefinition("Classify", run_classify_stage),
    StageDefinition("Investigate", investigate_stage),
    StageDefinition("Mitigate", mitigate_stage),
    StageDefinition("Restore", restore_stage),
    StageDefinition("Verify", verify_stage),
)


async def _run_stage(stage: StageDefinition) -> StageResult[object | None]:
    try:
        result = await cast(Callable[[], Awaitable[StageResult[object | None]]], stage.runner)()
    except Exception as exc:  # pragma: no cover - defensive boundary
        return StageResult(stage=stage.name, status="failed", error=str(exc))
    return result


async def run_iteration() -> list[StageResult[object | None]]:
    """Dispatch a single monitoring iteration and collect all completed results."""
    tasks = [asyncio.create_task(_run_stage(stage), name=stage.name) for stage in STAGES]
    return await asyncio.gather(*tasks)


def main() -> None:
    results = asyncio.run(run_iteration())
    for result in results:
        print(result.model_dump_json(indent=2))


if __name__ == "__main__":
    main()
