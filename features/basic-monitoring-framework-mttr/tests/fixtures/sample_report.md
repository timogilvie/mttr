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
| `hokusai-auth-development-deployment-circuit-breaker` | `OK` |
| `hokusai-auth-development-deployment-rollback` | `OK` |
| `hokusai-auth-development-elb-5xx-errors` | `INSUFFICIENT_DATA` |
| `hokusai-auth-development-excessive-task-stops` | `OK` |
| `hokusai-auth-development-high-cpu` | `OK` |
| `hokusai-auth-development-high-error-rate` | `OK` |
| `hokusai-auth-development-high-latency` | `OK` |
| `hokusai-auth-development-high-memory` | `OK` |
| `hokusai-auth-development-high-response-time` | `INSUFFICIENT_DATA` |
| `hokusai-auth-development-memory-utilization-high` | `OK` |
| `hokusai-auth-development-rate-limit` | `OK` |
| `hokusai-auth-development-redis-degradation` | `OK` |
| `hokusai-auth-development-running-tasks-low` | `OK` |
| `hokusai-auth-development-service-health` | `INSUFFICIENT_DATA` |
| `hokusai-auth-development-task-health` | `OK` |
| `hokusai-auth-development-unhealthy-hosts` | `INSUFFICIENT_DATA` |
| `hokusai-auth-development-unhealthy-targets` | `OK` |
| `hokusai-auth-development-usage-debit-rejected-high` | `OK` |

#### Log Summary

`/ecs/hokusai-auth/development`

| Signal | Count |
| --- | ---: |
| errors | 0 |
| warnings | 432 |
| http_5xx | 0 |
| http_4xx | 0 |
| validation_422 | 0 |
| payment_required_402 | 0 |
| usage_debit_calls | 138 |
| usage_debit_failures | 0 |
| model_30_calls | 48 |
| model_30_errors | 0 |

`/ecs/hokusai-auth-db-init`

| Signal | Count |
| --- | ---: |
| errors | 0 |
| warnings | 0 |
| http_5xx | 0 |
| http_4xx | 0 |
| validation_422 | 0 |
| payment_required_402 | 0 |
| usage_debit_calls | 0 |
| usage_debit_failures | 0 |
| model_30_calls | 0 |
| model_30_errors | 0 |

`/ecs/hokusai-auth-migrations`

| Signal | Count |
| --- | ---: |
| errors | 0 |
| warnings | 0 |
| http_5xx | 0 |
| http_4xx | 0 |
| validation_422 | 0 |
| payment_required_402 | 0 |
| usage_debit_calls | 0 |
| usage_debit_failures | 0 |
| model_30_calls | 0 |
| model_30_errors | 0 |

### data-pipeline-api

- ECS service: `hokusai-api-development`
- Status: `ACTIVE`
- Tasks: `1/1` running, `0` pending
- Task definition: `hokusai-api-development:323`

| ECS metric | Value |
| --- | ---: |
| CPU avg | 0.7% |
| Memory avg | 43.6% |

_ALB dims: TargetGroup=`targetgroup/hokusai-reg-api-development/aab4ed4b619b04c0` LoadBalancer=`app/hokusai-registry-development/78840d73e3e9652e`_

| ALB target | Requests | 2xx | 4xx | 5xx | Avg latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| `hokusai-reg-api-development` | 35 | 16 | 19 | - | 0.370s |

| Alarm | State |
| --- | --- |
| `hokusai-api-development-cpu-utilization-high` | `OK` |
| `hokusai-api-development-deployment-circuit-breaker` | `OK` |
| `hokusai-api-development-deployment-rollback` | `OK` |
| `hokusai-api-development-excessive-task-stops` | `OK` |
| `hokusai-api-development-memory-utilization-high` | `OK` |
| `hokusai-api-development-running-tasks-low` | `OK` |
| `hokusai-api-development-unhealthy-targets` | `OK` |
| `hokusai-api-health-development` | `OK` |
| `hokusai-rds-cpu-development` | `INSUFFICIENT_DATA` |

#### Log Summary

`/ecs/hokusai-api-development`

| Signal | Count |
| --- | ---: |
| errors | 0 |
| warnings | 1 |
| http_5xx | 0 |
| http_4xx | 19 |
| validation_422 | 0 |
| payment_required_402 | 0 |
| usage_debit_calls | 0 |
| usage_debit_failures | 0 |
| model_30_calls | 12 |
| model_30_errors | 0 |

`/ecs/hokusai/api/development`

| Signal | Count |
| --- | ---: |
| errors | 0 |
| warnings | 0 |
| http_5xx | 0 |
| http_4xx | 0 |
| validation_422 | 0 |
| payment_required_402 | 0 |
| usage_debit_calls | 0 |
| usage_debit_failures | 0 |
| model_30_calls | 0 |
| model_30_errors | 0 |

### mlflow

- ECS service: `hokusai-mlflow-development`
- Status: `ACTIVE`
- Tasks: `1/1` running, `0` pending
- Task definition: `hokusai-mlflow-development:172`

| ECS metric | Value |
| --- | ---: |
| CPU avg | 1.3% |
| Memory avg | 75.9% |

_ALB dims: TargetGroup=`targetgroup/hokusai-reg-mlflow-development/7717cca69079166e` LoadBalancer=`app/hokusai-registry-development/78840d73e3e9652e`_

| ALB target | Requests | 2xx | 4xx | 5xx | Avg latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| `hokusai-reg-mlflow-development` | 7 | 6 | 1 | - | 0.029s |

| Alarm | State |
| --- | --- |
| `hokusai-mlflow-development-cpu-utilization-high` | `OK` |
| `hokusai-mlflow-development-deployment-circuit-breaker` | `OK` |
| `hokusai-mlflow-development-deployment-rollback` | `OK` |
| `hokusai-mlflow-development-excessive-task-stops` | `OK` |
| `hokusai-mlflow-development-memory-utilization-high` | `OK` |
| `hokusai-mlflow-development-running-tasks-low` | `OK` |
| `hokusai-mlflow-development-unhealthy-targets` | `OK` |

#### Log Summary

`/ecs/hokusai-mlflow-development`

| Signal | Count |
| --- | ---: |
| errors | 0 |
| warnings | 1 |
| http_5xx | 0 |
| http_4xx | 1 |
| validation_422 | 0 |
| payment_required_402 | 0 |
| usage_debit_calls | 0 |
| usage_debit_failures | 0 |
| model_30_calls | 0 |
| model_30_errors | 0 |

`/ecs/hokusai/mlflow/development`

| Signal | Count |
| --- | ---: |
| errors | 0 |
| warnings | 0 |
| http_5xx | 0 |
| http_4xx | 0 |
| validation_422 | 0 |
| payment_required_402 | 0 |
| usage_debit_calls | 0 |
| usage_debit_failures | 0 |
| model_30_calls | 0 |
| model_30_errors | 0 |

## How To Read This

- ECS task count tells you whether the service is deployed and stable.
- ALB 5xx means the service or load balancer is returning server errors.
- ALB 4xx often means client/auth/schema issues; a sudden spike is still worth investigating.
- `validation_422` is especially important for integration contract drift.
- `usage_debit_failures` should normally be zero once usage reporting is healthy.

