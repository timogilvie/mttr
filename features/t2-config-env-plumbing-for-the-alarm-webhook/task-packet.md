# T2 · Config & env plumbing for the alarm webhook - Quick Reference

**Issue ID**: HOK-2435

## Objective

Add a validated configuration surface for the alarm-triggered investigate loop by introducing eight `ALARM_*` environment variables into `src/config.ts` and documenting them across `.env.example`, `.env.compose.example`, and `.env.ec2.example`. The feature must ship dark: `ALARM_WEBHOOK_ENABLED` defaults to `false` so no ingress route or consumer activates. This is pure config plumbing — no webhook route, SNS handler, or consumer logic is built here (those are downstream tickets under epic HOK-2433).

## Key Files

- `src/config.ts` — add `ALARM_*` parsing/validation and export typed config
- `src/__tests__/config.test.ts` — add tests for defaults, parsing, and validation
- `.env.example` — document all eight vars with defaults/comments
- `.env.compose.example` — mirror the documented vars
- `.env.ec2.example` — mirror the documented vars

## Critical Constraints

1. **Ships dark**: `ALARM_WEBHOOK_ENABLED` MUST default to `false`; config must parse cleanly with zero `ALARM_*` vars set.
2. **Follow the existing `src/config.ts` pattern** — match the current parsing/validation idiom (env reads, boolean/number coercion, error handling) exactly; do not introduce a new config library.
3. **No behavioral wiring** — do not add routes, consumers, SNS handlers, or reference `ALARM_WEBHOOK_PATH_TOKEN` outside config. Config surface only.

## Success Criteria (High-Level)

- [ ] All eight `ALARM_*` vars parse into a typed config object with the specified defaults
- [ ] Config validates cleanly when no `ALARM_*` vars are set (disabled by default)
- [ ] Invalid numeric/boolean/enum values produce clear, specific errors (or documented fallback)
- [ ] All eight vars documented in `.env.example`, `.env.compose.example`, `.env.ec2.example`
- [ ] Tests and lint pass; PR created and linked to HOK-2435

## Detailed Sections

Full details available on-demand in task-packet-details.md:

- [Section 1: Complete Objective & Scope](#1-objective)
- [Section 2: Technical Context](#2-technical-context)
- [Section 3: Implementation Approach](#3-implementation-approach)
- [Section 4: Success Criteria](#4-success-criteria)
- [Section 5: Implementation Constraints](#5-implementation-constraints)
- [Section 6: Validation Steps](#6-validation-steps)
- [Section 8: Definition of Done](#8-definition-of-done)
- [Section 9: Rollback Plan](#9-rollback-plan)
- [Section 10: Release Readiness](#10-release-readiness)
- [Section 11: Proposed Labels](#11-proposed-labels)

**Implementation Note**: Start with this overview. Read detailed sections on-demand as you implement. First action: open `src/config.ts` and `src/__tests__/config.test.ts` to learn the existing parsing/validation idiom before writing anything.

---

## 1. Objective

### What
Add and validate eight `ALARM_*` environment variables in `src/config.ts`, and document them in `.env.example`, `.env.compose.example`, and `.env.ec2.example`, so the alarm-triggered investigate loop has a configuration surface that ships disabled by default.

### Why
Epic HOK-2433 (alarm-triggered investigate loop for ASAP incident response) needs a webhook ingress route and a worker consumer that react to CloudWatch/SNS alarm notifications. Before any of that runtime behavior can be built (downstream tickets), the configuration surface must exist, be validated, and default to fully disabled ("ship dark"). This ticket (T2) delivers only that config plumbing so subsequent tickets can read typed, validated config values instead of raw `process.env` access.

### Scope In
- Add parsing + validation for the eight `ALARM_*` variables listed in the issue table to `src/config.ts`.
- Expose them via the existing exported config object/shape in `src/config.ts`, typed correctly.
- Apply the specified defaults: `ALARM_WEBHOOK_ENABLED=false`, `ALARM_WEBHOOK_VERIFY_SIGNATURE=true`, `ALARM_WEBHOOK_AUTOCONFIRM=true`, `ALARM_TRIGGER_MIN_SEVERITY=CRITICAL`, `ALARM_TRIGGER_COOLDOWN_MS=600000`, `ALARM_TRIGGER_POLL_MS=5000`, `ALARM_TRIGGER_COALESCE_MS=2000`; `ALARM_WEBHOOK_PATH_TOKEN` has no default (optional/empty when disabled).
- Add unit tests to `src/__tests__/config.test.ts` covering defaults, explicit overrides, and invalid values.
- Document all eight variables (with defaults and one-line purpose) in `.env.example`, `.env.compose.example`, and `.env.ec2.example`.

### Scope Out
- **No webhook ingress route** (HTTP handler for the SNS/alarm POST). Downstream ticket.
- **No SNS signature verification logic, subscription auto-confirm logic, or consumer/worker poll loop.** Downstream tickets.
- **No coalescing/cooldown/severity-trigger runtime behavior** — these vars are parsed and stored only; nothing consumes them yet.
- No changes to `docker-compose*.yml` service definitions beyond the `.env.*.example` documentation files (do not wire new env into compose service `environment:` blocks unless the existing pattern requires it for the examples to be meaningful — see Architecture Notes).
- No database schema changes.

---

## 2. Technical Context

### Repository
Single repo (the `mttr` / MTTR monitoring service). All work happens in the primary working directory on branch `task/t2-config-env-plumbing-for-the-alarm-webhook`.

### Key Files
- `src/config.ts` — existing central config module; add `ALARM_*` parsing/validation and export. **Modify.**
- `src/__tests__/config.test.ts` — existing config test file (appears in recent git activity under commit `a321f81`); add new test cases. **Modify.**
- `.env.example` — existing; document the eight vars. **Modify.**
- `.env.compose.example` — existing; mirror the documentation. **Modify.**
- `.env.ec2.example` — existing; mirror the documentation. **Modify.**
- `docs/alarm-triggered-investigation.md` — existing design doc (commit `707ff05`); **read §7** for the authoritative config spec, but do not modify.

### Relevant Subsystem Specs

> ⚠️ **Knowledge Gap**: No subsystem specs found under `.wavemill/context/` for the config subsystem. After implementation, consider running `wavemill context init --force` to create subsystem documentation and enable persistent downstream acceleration for future config/env tasks.

However, an authoritative design reference **does** exist in-repo: `docs/alarm-triggered-investigation.md` §7. Treat §7 as the source of truth for variable names, defaults, and semantics. If the design doc §7 disagrees with the issue table, prefer the design doc and note the discrepancy in the PR description.

### Dependencies
- Parent epic **HOK-2433** (design doc merged in PR #45). This ticket is the first implementation step; downstream tickets (webhook route, consumer) depend on this config surface.
- No new npm packages expected. Reuse whatever `src/config.ts` currently uses for env parsing (plain `process.env` reads, or an existing schema validator already imported there — confirm before adding anything).

### Architecture Notes
- **Follow the existing `src/config.ts` idiom exactly.** Before writing code, read the file end-to-end to determine: (a) whether it uses a validation library (e.g. zod/envalid) or hand-rolled `process.env` parsing; (b) how booleans are coerced (e.g. `=== 'true'`); (c) how numbers are parsed and range-checked; (d) how it groups/exports config (flat object vs. nested namespace); (e) how it throws/reports invalid values. Mirror all of these.
- **Grouping**: Prefer grouping the eight vars under a cohesive shape (e.g. an `alarmWebhook` / `alarmTrigger` section, or an `alarm` namespace) consistent with how existing config sections are organized. If the file is flat, stay flat.
- **Boolean parsing**: `ALARM_WEBHOOK_ENABLED`, `ALARM_WEBHOOK_VERIFY_SIGNATURE`, `ALARM_WEBHOOK_AUTOCONFIRM` are booleans. Match the existing boolean-parsing helper. Default `ENABLED` to `false`; the other two to `true`.
- **Numeric parsing**: `ALARM_TRIGGER_COOLDOWN_MS` (600000), `ALARM_TRIGGER_POLL_MS` (5000), `ALARM_TRIGGER_COALESCE_MS` (2000) are positive integers (milliseconds). Parse and reject non-numeric / negative values per the existing pattern.
- **Enum parsing**: `ALARM_TRIGGER_MIN_SEVERITY` defaults to `CRITICAL`. Determine the valid severity set from existing code (search for a severity enum/type in `src/types.ts` or classification code — commit `cbf4b1c` added an incident semantics model). Constrain to that set; if none exists, accept a documented string set (e.g. `INFO | WARNING | CRITICAL`) and validate against it.
- **Secret handling**: `ALARM_WEBHOOK_PATH_TOKEN` is a shared secret. It has no default. When `ALARM_WEBHOOK_ENABLED=false` it may be empty/undefined without error. Do **not** log its value anywhere. (Runtime enforcement of "token required when enabled" is a downstream concern; see Implementation Approach step 5 for the recommendation on whether to validate it here.)
- **`.env.*.example` files**: The three example files are documentation only (they carry placeholder values, not secrets). Add a clearly-labeled block for the alarm webhook vars with defaults and a one-line purpose each, matching the comment/formatting style already used in each file (they may differ slightly per file).

---

## 3. Implementation Approach

1. **Read the existing config module.** Open `src/config.ts` and `src/__tests__/config.test.ts` fully. Catalog the exact idiom for boolean parsing, number parsing, defaults, validation errors, and the exported shape. Do not write code until this is understood.
2. **Read design doc §7.** Open `docs/alarm-triggered-investigation.md`, section 7, and confirm variable names, defaults, and semantics against the issue table. Record any discrepancies for the PR description.
3. **Determine the severity enum.** Search `src/types.ts` and classification/validation code for an existing severity type (e.g. `INFO`/`WARNING`/`CRITICAL` or similar). Use it to constrain `ALARM_TRIGGER_MIN_SEVERITY`. If no enum exists, define the accepted set inline and document it.
4. **Add the eight vars to `src/config.ts`** using the existing idiom:
   - `ALARM_WEBHOOK_ENABLED` → boolean, default `false`.
   - `ALARM_WEBHOOK_PATH_TOKEN` → string, optional (default empty/undefined).
   - `ALARM_WEBHOOK_VERIFY_SIGNATURE` → boolean, default `true`.
   - `ALARM_WEBHOOK_AUTOCONFIRM` → boolean, default `true`.
   - `ALARM_TRIGGER_MIN_SEVERITY` → severity enum, default `CRITICAL`.
   - `ALARM_TRIGGER_COOLDOWN_MS` → positive int, default `600000`.
   - `ALARM_TRIGGER_POLL_MS` → positive int, default `5000`.
   - `ALARM_TRIGGER_COALESCE_MS` → positive int, default `2000`.
   Group them into a cohesive typed section consistent with existing structure.
5. **Decide token validation policy.** Recommended: do **not** hard-fail on a missing `ALARM_WEBHOOK_PATH_TOKEN` when `ENABLED=false` (ship dark). Optionally, if the existing config pattern supports conditional validation cheaply, throw a clear error only when `ALARM_WEBHOOK_ENABLED=true` **and** the token is empty. If conditional validation would deviate from the file's idiom, defer that check to the downstream route ticket and note it in the PR. Pick one and document the choice.
6. **Add tests** to `src/__tests__/config.test.ts` (see Section 6 for exact scenarios): defaults-only, explicit overrides, invalid boolean, invalid number, invalid severity, and the disabled-with-no-token case.
7. **Document the vars** in `.env.example`, `.env.compose.example`, and `.env.ec2.example`, matching each file's existing comment/format style. Include default values and the one-line purpose from the issue table. Leave `ALARM_WEBHOOK_PATH_TOKEN` blank with a comment indicating it is required only when the webhook is enabled.
8. **Run lint, typecheck, and tests.** Fix any issues. Confirm config still parses with a clean environment (no `ALARM_*` set).
9. **Commit** referencing HOK-2435 and **open a PR based on `main`** (per repo memory: always base PRs on `main`, never on another feature branch).

---

## 4. Success Criteria

### Functional Requirements

- [ ] **[REQ-F1]** With no `ALARM_*` environment variables set, `src/config.ts` loads without throwing, and the resulting config exposes: `enabled=false`, `verifySignature=true`, `autoconfirm=true`, `minSeverity='CRITICAL'`, `cooldownMs=600000`, `pollMs=5000`, `coalesceMs=2000`, and an empty/undefined path token.
- [ ] **[REQ-F2]** Each of the three boolean vars (`ALARM_WEBHOOK_ENABLED`, `ALARM_WEBHOOK_VERIFY_SIGNATURE`, `ALARM_WEBHOOK_AUTOCONFIRM`) is coerced from the string `'true'`/`'false'` using the same helper as existing config booleans, and an explicit override (e.g. `ALARM_WEBHOOK_ENABLED=true`) is reflected in the parsed config.
- [ ] **[REQ-F3]** Each of the three numeric vars (`ALARM_TRIGGER_COOLDOWN_MS`, `ALARM_TRIGGER_POLL_MS`, `ALARM_TRIGGER_COALESCE_MS`) parses a valid positive integer string into a `number`, and rejects (or falls back per documented policy on) non-numeric or negative input with a clear, specific message identifying the variable.
- [ ] **[REQ-F4]** `ALARM_TRIGGER_MIN_SEVERITY` accepts only values in the recognized severity set (default `CRITICAL`); an unrecognized value produces a clear error naming the variable and listing accepted values (or falls back per documented policy).
- [ ] **[REQ-F5]** `ALARM_WEBHOOK_PATH_TOKEN` is read as a string with no default; when unset and `ALARM_WEBHOOK_ENABLED=false`, config loads without error. The token value is never written to logs.
- [ ] **[REQ-F6]** All eight variables appear, with defaults and a one-line purpose comment, in `.env.example`, `.env.compose.example`, and `.env.ec2.example`.

### Non-Functional Requirements
- [ ] Config parsing adds no measurable startup latency (synchronous env reads only; no I/O, no network).
- [ ] `ALARM_WEBHOOK_PATH_TOKEN` is never logged or echoed, including in validation error messages (error must reference the variable name, not its value).

### Code Quality
- [ ] Follows the existing `src/config.ts` patterns (parsing helpers, export shape, error style).
- [ ] TypeScript types are correct — the new config section is fully typed (no `any`); severity is a union/enum type, booleans are `boolean`, ms values are `number`.
- [ ] No lint errors.

---

## 5. Implementation Constraints

- **Code style**: Match `src/config.ts` conventions exactly — reuse existing boolean/number parse helpers; do not introduce a new config/validation library. If the file uses a schema validator already, extend that schema; if it hand-rolls parsing, hand-roll consistently.
- **Ship dark**: `ALARM_WEBHOOK_ENABLED` MUST default to `false`. No code path introduced here may activate a route, consumer, or network listener.
- **No downstream wiring**: Do not add the webhook route, SNS verification, subscription confirm, or consumer loop. Do not reference these config values anywhere outside `src/config.ts` and its tests.
- **Testing**: Add unit tests to `src/__tests__/config.test.ts` using the existing test runner (Vitest, per `vite.config.ts`/`src/__tests__` conventions). Tests must set/unset env vars hermetically (save & restore `process.env`, or use the runner's env stubbing) so they don't leak state.
- **Security**: Never log `ALARM_WEBHOOK_PATH_TOKEN`. Validation errors must not include its value.
- **Backwards compatibility**: Purely additive. Existing config keys, names, and behavior must be unchanged. Existing tests must still pass.
- **PR base**: Base the PR on `main` (per repo convention), not on any other feature branch. Commit message must reference `HOK-2435`.

---

## 6. Validation Steps

### Functional Requirement Validation

**[REQ-F1] Defaults load cleanly with no ALARM_* env set**

Validation scenario:
1. Setup: Ensure no `ALARM_*` keys exist in `process.env` (delete any in the test's env snapshot).
2. Action: Load the config module (import fresh, or call the config factory/loader) with a clean environment.
3. Expected result: No throw. Parsed config exposes `enabled=false`, `verifySignature=true`, `autoconfirm=true`, `minSeverity='CRITICAL'`, `cooldownMs=600000`, `pollMs=5000`, `coalesceMs=2000`, and token empty/undefined.
4. Edge cases:
   - `ALARM_WEBHOOK_ENABLED` present but empty string (`''`) → treated as unset → `enabled=false`.
   - Entire config module loads in a process where only unrelated vars (e.g. `DATABASE_URL`) are set → still no throw, alarm defaults intact.

**[REQ-F2] Boolean coercion and overrides**

Validation scenario:
1. Setup: Set `ALARM_WEBHOOK_ENABLED='true'`, `ALARM_WEBHOOK_VERIFY_SIGNATURE='false'`, `ALARM_WEBHOOK_AUTOCONFIRM='false'`.
2. Action: Load config.
3. Expected result: `enabled=true`, `verifySignature=false`, `autoconfirm=false` (all `boolean` type, not string).
4. Edge cases:
   - `ALARM_WEBHOOK_ENABLED='TRUE'` (uppercase) → follow existing helper behavior; document result (if helper is strict-lowercase, this parses to `false` — assert whichever the existing helper does, and keep it consistent with other booleans in the file).
   - `ALARM_WEBHOOK_ENABLED='1'` → follow existing helper behavior; assert the same result the file's other booleans would give.

**[REQ-F3] Numeric parsing and rejection**

Validation scenario:
1. Setup: Set `ALARM_TRIGGER_COOLDOWN_MS='120000'`, `ALARM_TRIGGER_POLL_MS='3000'`, `ALARM_TRIGGER_COALESCE_MS='500'`.
2. Action: Load config.
3. Expected result: `cooldownMs=120000`, `pollMs=3000`, `coalesceMs=500`, all typeof `number`.
4. Edge cases:
   - `ALARM_TRIGGER_POLL_MS='abc'` → throws (or documented fallback) with message naming `ALARM_TRIGGER_POLL_MS`.
   - `ALARM_TRIGGER_COOLDOWN_MS='-1'` → rejected as non-positive with message naming the variable.
   - `ALARM_TRIGGER_COALESCE_MS='0'` → decide & document: recommend rejecting (`> 0` required) and assert accordingly; if the design doc §7 permits `0`, accept and assert `0`.

**[REQ-F4] Severity enum validation**

Validation scenario:
1. Setup: Set `ALARM_TRIGGER_MIN_SEVERITY='WARNING'` (a value in the recognized set).
2. Action: Load config.
3. Expected result: `minSeverity='WARNING'`.
4. Edge cases:
   - `ALARM_TRIGGER_MIN_SEVERITY='banana'` → throws (or documented fallback) with message naming the variable and listing accepted values.
   - `ALARM_TRIGGER_MIN_SEVERITY='critical'` (lowercase) → decide & document: recommend case-insensitive normalization to `CRITICAL`; assert whichever behavior is implemented, consistently.

**[REQ-F5] Path token: no default, not logged, ok when disabled**

Validation scenario:
1. Setup: Ensure `ALARM_WEBHOOK_PATH_TOKEN` unset and `ALARM_WEBHOOK_ENABLED` unset/`false`.
2. Action: Load config; capture any log output during load.
3. Expected result: Config loads; token is empty/undefined; no log line contains a token value.
4. Edge cases:
   - `ALARM_WEBHOOK_PATH_TOKEN='s3cr3t'` set → config exposes it as a string; assert no `console.*`/logger call emitted the literal `s3cr3t` during load.
   - `ALARM_WEBHOOK_ENABLED='true'` with token unset → per chosen policy (step 5): either loads (deferred check) or throws a clear error naming `ALARM_WEBHOOK_PATH_TOKEN` **without** printing a value. Assert the documented choice.

**[REQ-F6] Example files document all eight vars**

Validation scenario:
1. Setup: Open `.env.example`, `.env.compose.example`, `.env.ec2.example`.
2. Action: Grep each file for the eight variable names.
3. Expected result: Each file contains all eight names, each with its default value (except the token, left blank) and a one-line purpose comment.
4. Edge cases:
   - Token line present but value blank, with a comment noting "required only when `ALARM_WEBHOOK_ENABLED=true`".
   - Formatting/comment style matches the surrounding block in each respective file.

---

### Input/Output Verification

**Valid Inputs:**
- Input: (no `ALARM_*` set) → Expected: `enabled=false, verifySignature=true, autoconfirm=true, minSeverity='CRITICAL', cooldownMs=600000, pollMs=5000, coalesceMs=2000`, token empty.
- Input: `ALARM_TRIGGER_COOLDOWN_MS='120000'` → Expected: `cooldownMs=120000` (number).
- Input: `ALARM_TRIGGER_MIN_SEVERITY='WARNING'` → Expected: `minSeverity='WARNING'`.

**Invalid Inputs:**
- Input: `ALARM_TRIGGER_POLL_MS='abc'` → Expected: clear error naming `ALARM_TRIGGER_POLL_MS` (or documented fallback to default `5000`).
- Input: `ALARM_TRIGGER_COOLDOWN_MS='-1'` → Expected: rejection naming the variable (non-positive).
- Input: `ALARM_TRIGGER_MIN_SEVERITY='banana'` → Expected: error naming the variable + listing accepted severities.

---

### Standard Validation Commands

```bash
# 1. Lint passes
pnpm lint
# Expected: no errors

# 2. Type check passes
pnpm typecheck
# Expected: no type errors (new alarm config section fully typed)

# 3. Tests pass (config suite specifically)
pnpm test src/__tests__/config.test.ts
# Expected: all config tests pass, including new alarm cases

# 4. Full test suite (no regressions)
pnpm test
# Expected: all existing tests still pass

# 5. Build succeeds
pnpm build
# Expected: no build errors
```

*(Adjust command names to match `package.json` scripts if they differ — verify the actual script names before running.)*

---

### Manual Verification Checklist

- [ ] Start the app/process with a clean env (no `ALARM_*`) → it boots and no alarm route/consumer activates (verify nothing new listens; grep for any accidental route registration).
- [ ] Confirm `git diff` touches only `src/config.ts`, `src/__tests__/config.test.ts`, and the three `.env.*.example` files (no stray edits).
- [ ] Grep the diff for the literal token value in any log/console statement → none present.
- [ ] Confirm design doc §7 variable names/defaults match the implemented config; note any discrepancy in the PR.

---

## 7. Definition of Done

- [ ] All success criteria (REQ-F1…F6) met.
- [ ] All validation steps pass with the specific, measurable outcomes above.
- [ ] Each functional requirement has at least one concrete validation scenario (done in Section 6).
- [ ] Edge cases documented and tested (invalid boolean/number/severity; disabled-with-no-token; token-not-logged).
- [ ] No unrelated changes included (diff limited to the five files).
- [ ] Commit message references `HOK-2435`.
- [ ] PR created (based on `main`), described, and linked to the Linear issue; PR notes the chosen token-validation policy and any design-doc discrepancies.

---

## 8. Rollback Plan

- **Revert commit**: `git revert <sha>` — the change is purely additive config plumbing; reverting removes the `ALARM_*` config section and example-file docs with no runtime dependents (feature ships dark, nothing consumes these values yet).
- **Feature flag**: `ALARM_WEBHOOK_ENABLED=false` is the effective kill-switch; even if merged, the feature is inert until a downstream ticket both sets it true and adds the route/consumer.
- **Data migration rollback**: N/A — no schema or data changes.

---

## 9. Release Readiness
- **database_change_risk**: none
- **env_changes**: ALARM_WEBHOOK_ENABLED, ALARM_WEBHOOK_PATH_TOKEN, ALARM_WEBHOOK_VERIFY_SIGNATURE, ALARM_WEBHOOK_AUTOCONFIRM, ALARM_TRIGGER_MIN_SEVERITY, ALARM_TRIGGER_COOLDOWN_MS, ALARM_TRIGGER_POLL_MS, ALARM_TRIGGER_COALESCE_MS
- **config_changes**: src/config.ts, .env.example, .env.compose.example, .env.ec2.example
- **manual_steps**: none

---

## 10. Proposed Labels

**Risk Level** (Required):

**Selected**: `Risk: Low`

**Justification**: Low — purely additive config parsing with defaults; feature ships dark (`ENABLED=false`), no runtime wiring, no schema changes, no consumers of the new values. Isolated to one config module, its test, and three documentation example files.

---

**Files to Modify** (Auto-detected):
- `src/config.ts`
- `src/__tests__/config.test.ts`
- `.env.example`
- `.env.compose.example`
- `.env.ec2.example`

**Label**: `Files: config.ts, config.test.ts, .env.example, .env.compose.example, .env.ec2.example`

**Purpose**: Prevents parallel tasks from modifying the same config surface.

---

**Architectural Layer** (Recommended):

**Selected**: `Layer: Infra`

**Purpose**: Config/env plumbing; can run in parallel with UI/Service/Database tasks that don't touch `src/config.ts`.

---

**Area** (Recommended):

**Selected**: `Area: Alarm Webhook` (epic HOK-2433)

**Purpose**: Avoid running two tasks that touch the alarm-webhook config surface simultaneously.

---

**Test Coverage** (Auto-detected):

**Selected**: `Tests: Unit`

**Purpose**: Config unit tests only; can run in parallel with other unit-test tasks.

---

**Component** (Optional):

**Selected**: `Component: Config`

**Purpose**: Avoid two tasks editing `src/config.ts` at once.

---

### Label Summary

```
Suggested labels for this task:
- Risk: Low
- Files: src/config.ts, src/__tests__/config.test.ts, .env.example, .env.compose.example, .env.ec2.example
- Layer: Infra
- Area: Alarm Webhook
- Tests: Unit
- Component: Config
```

**How these labels help the autonomous workflow:**
- **Risk: Low** — Many Low-risk tasks can run in parallel.
- **Files: ...** — Prevents config-surface conflicts with other tasks.
- **Layer: Infra** — Parallel-safe with UI/Service/Database work.
- **Area: Alarm Webhook** — Serializes alarm-webhook epic tasks to avoid config collisions.
- **Tests: Unit** — Parallel-safe with other unit-test tasks.
- **Component: Config** — Prevents two tasks editing `src/config.ts` simultaneously.