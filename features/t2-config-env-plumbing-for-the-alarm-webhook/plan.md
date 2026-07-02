# Implementation Plan — T2 · Config & env plumbing for the alarm webhook (HOK-2435)

## 1. Objective

Add the typed, validated configuration surface for the alarm-triggered investigate
loop (design doc §7) so downstream tickets (T3/T4/T5) read config values instead of
raw `process.env`. **Purely additive, ships dark:** `ALARM_WEBHOOK_ENABLED` defaults
to `false`, nothing consumes the new values yet, no route/consumer/listener is added.

Scope is exactly four files:
- `src/config.ts` — new typed `alarm` config section + parse/validate
- `src/__tests__/config.test.ts` — unit tests for the new section
- `.env.example`, `.env.compose.example`, `.env.ec2.example` — documentation

Out of scope (explicit non-goals from packet §2): DB schema, webhook route, SNS
verification, subscription confirm, consumer loop, compose `environment:` wiring, any
consumer of the new values.

## 2. Research findings (codebase conventions)

**`src/config.ts` idiom** (hand-rolled, no schema library — reuse it as-is):
- `getEnv(key, default?)` — required string; throws naming the var if missing.
- `getEnvOptional(key)` — `string | undefined`; empty string → `undefined`.
- `getEnvNumber(key, default)` — parses, throws `"... must be a valid number"` naming var.
- `getEnvBoolean(key, default)` — accepts `1/true/yes/on` & `0/false/no/off` (case-insensitive), else throws naming var. Empty/unset → default.
- Enum idiom: `getStateBackend()` validates against a fixed set and throws naming the var.
- Conditional validation idiom already exists: `if (stateBackend === 'postgres' && !databaseUrl) throw new Error('DATABASE_URL is required when STATE_BACKEND=postgres')`.
- Optional-secret idiom: `slackWebhookUrl` via `getEnvOptional`, spread conditionally into the object (`...(slackWebhookUrl ? { webhookUrl: slackWebhookUrl } : {})`).
- Config shape is **nested namespaces** (`openrouter`, `investigate`, `alerts.slack`, …).

**Severity type** — `src/types.ts:1`:
```ts
export type Severity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
```
> **Discrepancy to record in the PR:** the task packet's illustrative severity set
> (`INFO | WARNING | CRITICAL`) and its `WARNING` example value do **not** match the
> real `Severity` type. We constrain `ALARM_TRIGGER_MIN_SEVERITY` to the actual
> `Severity` union and use `HIGH`/`MEDIUM` (not `WARNING`) in tests.

**Env-example files** — flat `KEY=value` with `#` section comments; `.env.example` is the
full local reference, `.env.compose.example` and `.env.ec2.example` are deployment
subsets. Parsed by `src/env.ts` `loadEnvFile` (supports `#` comments, quotes).

**Consumers** — `src/index.ts` calls `loadEnvFile()` then `loadConfig()`. No other change
needed; adding a section is backward-compatible.

## 3. Design decisions

### 3.1 Config shape — new `alarm` namespace (nested, two sub-groups)
```ts
alarm: {
  webhook: {
    enabled: boolean;
    pathToken?: string;        // optional; omitted when empty (mirrors slack.webhookUrl)
    verifySignature: boolean;
    autoconfirm: boolean;
  };
  trigger: {
    minSeverity: Severity;
    cooldownMs: number;
    pollMs: number;
    coalesceMs: number;
  };
}
```
Rationale: matches the doc's `ALARM_WEBHOOK_*` / `ALARM_TRIGGER_*` grouping and the
file's existing nested-namespace style (`alerts.slack`).

### 3.2 Severity parsing — reuse the real `Severity` type
Add `import type { Severity } from './types.js';` and a `getEnvSeverity(key, default)`
helper modeled on `getStateBackend`:
- Empty/unset → default (`'CRITICAL'`).
- **Case-insensitive**: normalize input to uppercase before matching (ergonomic; env
  values are commonly lowercase). Documented behavior — `critical` → `CRITICAL`.
- Invalid → throw `Environment variable ALARM_TRIGGER_MIN_SEVERITY must be one of NONE, LOW, MEDIUM, HIGH, CRITICAL, got: <value>` (names the var + lists accepted values).

### 3.3 Path-token validation policy — conditional, mirrors the postgres/DATABASE_URL idiom
- `pathToken` read via `getEnvOptional` (no default; `undefined` when empty).
- **Throw only when `ALARM_WEBHOOK_ENABLED=true` AND token is empty:**
  `throw new Error('ALARM_WEBHOOK_PATH_TOKEN is required when ALARM_WEBHOOK_ENABLED=true')`.
- Chosen because this exact conditional-validation pattern already exists in the file
  (`DATABASE_URL` required when `STATE_BACKEND=postgres`), so it fits the idiom cheaply
  and adds a real safety gate. When disabled (the default), missing token loads fine →
  ships dark.
- **Security:** the token value is never interpolated into any error/log message — the
  error names only the variable. `getEnvOptional` never logs.

### 3.4 Boolean/number parsing — reuse existing helpers
`getEnvBoolean` for `ENABLED` / `VERIFY_SIGNATURE` / `AUTOCONFIRM`; `getEnvNumber` for
`COOLDOWN_MS` / `POLL_MS` / `COALESCE_MS`. No new helpers except `getEnvSeverity`.

## 4. Implementation steps

1. **`src/config.ts` — interface.** Add the `alarm` block (§3.1) to the `Config`
   interface. Add `import type { Severity } from './types.js';` at the top.
2. **`src/config.ts` — severity helper.** Add `SEVERITIES` constant + `getEnvSeverity`
   near `getStateBackend`.
3. **`src/config.ts` — `loadConfig`.** Near the top of the function (with the other
   pre-computed locals) read `alarmWebhookEnabled` and `alarmWebhookPathToken`; add the
   conditional token-required check. Add the `alarm: { webhook: {...}, trigger: {...} }`
   object to the returned config, using the env keys/defaults from the table below.
4. **`src/__tests__/config.test.ts`** — add tests (§5). Existing hermetic
   `process.env` save/restore in `beforeEach/afterEach` already covers isolation.
5. **`.env.example`** — append an `# Alarm-triggered investigate loop (ships dark …)`
   section with all 8 vars at their defaults, `ALARM_WEBHOOK_PATH_TOKEN=` empty, plus a
   one-line note that a token is required only when enabled.
6. **`.env.compose.example` & `.env.ec2.example`** — append a matching commented
   section (master switch `ALARM_WEBHOOK_ENABLED=false` + `ALARM_WEBHOOK_PATH_TOKEN=`
   placeholder and the trigger tunables), documentation only — no compose service
   `environment:` changes.

### Env var → config mapping
| Env var | Helper | Default | Config path |
|---|---|---|---|
| `ALARM_WEBHOOK_ENABLED` | getEnvBoolean | `false` | `alarm.webhook.enabled` |
| `ALARM_WEBHOOK_PATH_TOKEN` | getEnvOptional | — (undefined) | `alarm.webhook.pathToken?` |
| `ALARM_WEBHOOK_VERIFY_SIGNATURE` | getEnvBoolean | `true` | `alarm.webhook.verifySignature` |
| `ALARM_WEBHOOK_AUTOCONFIRM` | getEnvBoolean | `true` | `alarm.webhook.autoconfirm` |
| `ALARM_TRIGGER_MIN_SEVERITY` | getEnvSeverity | `CRITICAL` | `alarm.trigger.minSeverity` |
| `ALARM_TRIGGER_COOLDOWN_MS` | getEnvNumber | `600000` | `alarm.trigger.cooldownMs` |
| `ALARM_TRIGGER_POLL_MS` | getEnvNumber | `5000` | `alarm.trigger.pollMs` |
| `ALARM_TRIGGER_COALESCE_MS` | getEnvNumber | `2000` | `alarm.trigger.coalesceMs` |

## 5. Test scenarios (`src/__tests__/config.test.ts`)

1. **Defaults** — only `OPENROUTER_API_KEY` set, all `ALARM_*` deleted → `enabled=false`,
   `verifySignature=true`, `autoconfirm=true`, `minSeverity='CRITICAL'`,
   `cooldownMs=600000`, `pollMs=5000`, `coalesceMs=2000`, `pathToken` undefined.
2. **Explicit overrides** — set all 8 (`ENABLED=true` + a token, `VERIFY_SIGNATURE=false`,
   `AUTOCONFIRM=false`, `MIN_SEVERITY=HIGH`, numeric overrides) → all reflected.
3. **Severity case-insensitive** — `ALARM_TRIGGER_MIN_SEVERITY=medium` → `minSeverity='MEDIUM'`.
4. **Invalid severity** — `ALARM_TRIGGER_MIN_SEVERITY=banana` → throws naming the var (and listing accepted values).
5. **Invalid boolean** — `ALARM_WEBHOOK_ENABLED=maybe` → throws naming `ALARM_WEBHOOK_ENABLED`.
6. **Invalid number** — `ALARM_TRIGGER_POLL_MS=soon` → throws naming `ALARM_TRIGGER_POLL_MS`.
7. **Disabled + no token** — `ENABLED` unset, no token → loads without throwing (ship-dark).
8. **Enabled + no token** — `ALARM_WEBHOOK_ENABLED=true`, token unset → throws naming
   `ALARM_WEBHOOK_PATH_TOKEN`, and the assertion confirms no token value in the message.

## 6. Edge cases & gotchas
- Empty string (`ALARM_WEBHOOK_PATH_TOKEN=`) must behave as unset — `getEnvOptional` handles this.
- Don't break existing tests — change is purely additive; existing keys untouched.
- Import `Severity` as a **type-only** import to avoid runtime coupling.
- Keep example files' style consistent (flat `KEY=value`, `#` comments); no quoting needed.
- Never echo the token — verified by test 8 asserting the error string excludes any value.

## 7. Release Readiness
- **database_change_risk**: `none`
- **env_changes**: `ALARM_WEBHOOK_ENABLED, ALARM_WEBHOOK_PATH_TOKEN, ALARM_WEBHOOK_VERIFY_SIGNATURE, ALARM_WEBHOOK_AUTOCONFIRM, ALARM_TRIGGER_MIN_SEVERITY, ALARM_TRIGGER_COOLDOWN_MS, ALARM_TRIGGER_POLL_MS, ALARM_TRIGGER_COALESCE_MS`
- **config_changes**: `.env.example, .env.compose.example, .env.ec2.example` (source edits: `src/config.ts`, `src/__tests__/config.test.ts`)
- **manual_steps**: `none` (ships dark; no deploy action required to land this ticket)

## 8. Routing / provenance
- Task packet expanded via `expand-issue.ts`; artifacts in feature dir.
- Post-expansion route: `.post-expansion-route.json` (local stage-aware fallback; remote router returned `missing_auth`). Signals: taskType bugfix-shaped, complexityScore 1, riskScore 13, expectedSuccess 0.95.
- **No migration** — T1 owns the DB migration; T2 is config-only. No `.migration-detected` marker.
