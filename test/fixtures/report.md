# Hokusai Service Health Report

- Window: last 24 hours
- Region: `us-east-1`
- Generated: `2026-06-06T11:35:04.881055+00:00`

## Executive Summary

- `auth-service`: ECS `1/1` running, 0 active alarm(s).
- `data-pipeline-api`: ECS `1/1` running, 0 active alarm(s).
- `mlflow`: ECS `1/1` running, 0 active alarm(s).

## Service Details

### auth-service

- ECS service: `hokusai-auth-development`
- Status: `ACTIVE`
- Tasks: `1/1` running, `0` pending
- Task definition: `hokusai-auth-development:107`

| ECS metric | Value |
| --- | ---: |
| CPU avg | 1.7% |
| Memory avg | 22.8% |

_ALB dims: TargetGroup=`targetgroup/hokusai-auth-ded-development/cc883b7a7e0a82ce` LoadBalancer=`app/hokusai-auth-development/50f2dcd2a4ec4e6a`_

| ALB target | Requests | 2xx | 4xx | 5xx | Avg latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| `hokusai-auth-ded-development` | 1864 | 241 | 1395 | - | 0.125s |

| Alarm | State |
| --- | --- |
| `hokusai-auth-development-auth-failures` | `OK` |
| `hokusai-auth-development-cpu-utilization-high` | `OK` |

#### Log Summary

`/ecs/hokusai-auth/development`

| Signal | Count |
| --- | ---: |
| errors | 0 |
| warnings | 432 |
| http_5xx | 0 |
| http_4xx | 0 |
