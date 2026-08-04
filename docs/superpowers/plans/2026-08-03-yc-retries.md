# Retries for Transient Yandex Cloud Errors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the action survive transient Yandex Cloud failures (notably `RESOURCE_EXHAUSTED: The limit on maximum number of active operations has exceeded`) instead of failing the job on the first rejection. Resolves [#700](https://github.com/yc-actions/yc-github-runner/issues/700).

**Architecture:** `@yandex-cloud/nodejs-sdk` already ships retry middleware with `RESOURCE_EXHAUSTED` in its default retryable set; it is inert because `retry` defaults to `false` for non-idempotent methods and the call sites pass no options. We add one module, `src/retry.ts`, that owns the backoff schedule and budget math, then feed its output into the existing SDK middleware at each call site. Retrying non-idempotent `Create`/`Delete` is made safe by sending Yandex Cloud's `Idempotency-Key` header. The non-gRPC token-exchange POST gets a small hand-rolled wrapper using the same schedule.

**Tech Stack:** TypeScript (ES2022, NodeNext, `strict`), Jest + ts-jest, `@yandex-cloud/nodejs-sdk` v2, `nice-grpc`, `axios`, `moment`, `@actions/core`, `@vercel/ncc`.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-03-yc-retries-design.md`. Do not change behavior it does not describe.
- Nominal backoff schedule is **10s → 20s → 40s → 60s → 60s → …** (four steps climbing to a minute, then fixed one-minute intervals).
- SDK constants must be `retryBaseDelayMs = 13333` and `retryMaxDelayMs = 80000`. These are the nominal targets divided by the SDK's 0.75 jitter mean; do not "simplify" them to 10000/60000, which would make the real delays 25% short.
- Retryable gRPC statuses: `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `UNKNOWN`, `INTERNAL`.
- The 30-minute budget maximum is a **silent internal clamp with a warning, never a validation error**. An oversized `retry-timeout` must not fail the job at startup.
- Default `retry-timeout` is `PT5M`. `PT0S` disables retries.
- `retryMaxAttempts` counts **retries**, not total calls: `N` means up to `N + 1` calls.
- Every `Create`/`Delete` call sends one `idempotency-key` UUID generated **before** the call, so all retries of that call share it.
- Indentation is 4 spaces, single quotes, no semicolons — run `npm run format` before committing (Prettier config is in `.prettierrc.json`).
- `dist/` is committed and is what GitHub actually runs. It must be rebuilt and committed (Task 6).
- Run tests with `npm test` (it sets the `GITHUB_REPOSITORY` and `GITHUB_WORKSPACE` env vars the config tests need). Bare `npx jest` will fail.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/retry.ts` | **Create.** Sole owner of the backoff schedule, the budget→attempts math, the 30-minute clamp, the SDK `RetryOptions` factory, and the HTTP retry wrapper. |
| `src/config.ts` | **Modify.** Parse the new `retry-timeout` input into `retryTimeoutMs: number` on `ActionConfig`. |
| `src/main.ts` | **Modify.** Pass retry options + idempotency key to `instanceService.create`/`.delete`; wrap `exchangeToken` in `withRetry`. |
| `action.yml` | **Modify.** Declare the `retry-timeout` input. |
| `README.md` | **Modify.** Document the input. |
| `package.json` | **Modify.** Promote `nice-grpc` from transitive to direct dependency. |
| `__tests__/retry.test.ts` | **Create.** Unit tests for the schedule, budget math, clamp, options factory, and HTTP wrapper. |
| `__tests__/config.test.ts` | **Modify.** Tests for `parseRetryTimeout`; add the new required field to the three existing `ActionConfig` literals. |
| `dist/` | **Modify.** Rebuilt bundle (Task 6). |

---

## Task 1: Retry schedule and gRPC options

Creates `src/retry.ts` with everything except the HTTP wrapper (Task 2), plus the `nice-grpc` dependency it needs.

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/retry.ts`
- Test: `__tests__/retry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `MAX_BUDGET_MS: number` (= `1_800_000`)
  - `delayForAttempt(attempt: number): number`
  - `attemptsForBudget(budgetMs: number): number`
  - `clampBudget(budgetMs: number): number`
  - `grpcRetryOptions(budgetMs: number, opName: string): RetryOptions`

**Background you need:** The SDK's middleware (`node_modules/@yandex-cloud/nodejs-sdk/dist/middleware/retry.js`) computes each pause as `delay = min(retryMaxDelayMs, 2^k · retryBaseDelayMs) · (1 + Math.random()) / 2`. Because `Math.random()` is uniform on [0,1), the expected multiplier is `0.75`. That is why the constants are the nominal targets divided by `0.75`. The middleware stops when `attempt >= retryMaxAttempts`, so `retryMaxAttempts` is a count of retries.

- [ ] **Step 1: Add `nice-grpc` as a direct dependency**

The SDK re-exports neither `Status` nor `Metadata`, and we need both. `nice-grpc` is already present transitively at version 1.2.2; make it explicit rather than deep-importing through the SDK's `node_modules`.

Add to the `dependencies` block of `package.json`, keeping alphabetical order (it goes immediately after `"js-yaml"`):

```json
    "nice-grpc": "^1.2.2",
```

Then run:

```bash
npm install
```

- [ ] **Step 2: Write the failing tests**

Create `__tests__/retry.test.ts`:

```ts
import { describe, expect, test } from '@jest/globals'
import { Status } from 'nice-grpc'
import { attemptsForBudget, clampBudget, delayForAttempt, grpcRetryOptions, MAX_BUDGET_MS } from '../src/retry'

describe('delayForAttempt', () => {
    test('climbs to a minute over four steps, then stays there', () => {
        expect(delayForAttempt(0)).toBe(10_000)
        expect(delayForAttempt(1)).toBe(20_000)
        expect(delayForAttempt(2)).toBe(40_000)
        expect(delayForAttempt(3)).toBe(60_000)
        expect(delayForAttempt(4)).toBe(60_000)
        expect(delayForAttempt(50)).toBe(60_000)
    })
})

describe('attemptsForBudget', () => {
    test('no budget means no retries', () => {
        expect(attemptsForBudget(0)).toBe(0)
        expect(attemptsForBudget(-1)).toBe(0)
    })

    test('a retry is only counted if its whole delay fits', () => {
        expect(attemptsForBudget(9_999)).toBe(0)
        expect(attemptsForBudget(10_000)).toBe(1)
        expect(attemptsForBudget(29_999)).toBe(1)
        expect(attemptsForBudget(30_000)).toBe(2)
    })

    test('matches the documented budget table', () => {
        expect(attemptsForBudget(5 * 60_000)).toBe(6)
        expect(attemptsForBudget(10 * 60_000)).toBe(11)
        expect(attemptsForBudget(30 * 60_000)).toBe(31)
    })
})

describe('clampBudget', () => {
    test('passes through values within the cap', () => {
        expect(clampBudget(5 * 60_000)).toBe(300_000)
        expect(clampBudget(MAX_BUDGET_MS)).toBe(MAX_BUDGET_MS)
    })

    test('clamps rather than throws above the cap', () => {
        expect(() => clampBudget(2 * 60 * 60_000)).not.toThrow()
        expect(clampBudget(2 * 60 * 60_000)).toBe(MAX_BUDGET_MS)
    })

    test('floors negative budgets at zero', () => {
        expect(clampBudget(-5000)).toBe(0)
    })
})

describe('grpcRetryOptions', () => {
    test('emits the constants that place expected delays on the schedule', () => {
        const options = grpcRetryOptions(5 * 60_000, 'Create instance')

        // 13333 * 0.75 = 10s, doubling to 20s and 40s; 80000 * 0.75 = 60s thereafter.
        expect(options.retryBaseDelayMs).toBe(13_333)
        expect(options.retryMaxDelayMs).toBe(80_000)
        expect(options.retry).toBe(true)
        expect(options.retryMaxAttempts).toBe(6)
    })

    test('retries the four transient statuses', () => {
        const options = grpcRetryOptions(5 * 60_000, 'Create instance')

        expect(options.retryableStatuses).toEqual([
            Status.RESOURCE_EXHAUSTED,
            Status.UNAVAILABLE,
            Status.UNKNOWN,
            Status.INTERNAL
        ])
    })

    test('a zero budget disables retrying entirely', () => {
        const options = grpcRetryOptions(0, 'Create instance')

        expect(options.retry).toBe(false)
        expect(options.retryMaxAttempts).toBe(0)
    })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- retry.test.ts`

Expected: FAIL — `Cannot find module '../src/retry'`.

- [ ] **Step 4: Write the implementation**

Create `src/retry.ts`:

```ts
import { info, warning } from '@actions/core'
import { RetryOptions } from '@yandex-cloud/nodejs-sdk/dist/middleware/retry'
import { Status } from 'nice-grpc'

/**
 * Nominal backoff schedule: 10s -> 20s -> 40s -> 60s -> 60s -> ...
 * Four steps climbing to a minute, then a fixed one-minute interval.
 */
const CLIMB_MS = [10_000, 20_000, 40_000]
const STEADY_MS = 60_000

/** Internal cap on the retry budget. Larger values are clamped, never rejected. */
export const MAX_BUDGET_MS = 30 * 60_000

/**
 * The SDK middleware computes `delay = min(cap, 2^k * base) * (1 + random()) / 2`,
 * so the expected delay is 0.75 of the backoff. Dividing the nominal targets by
 * 0.75 makes the expected delays land on the schedule above while keeping the
 * jitter -- which matters here, because the error we retry is caused by many jobs
 * hitting the cloud at once, and unjittered retries would collide all over again.
 */
const JITTER_MEAN = 0.75
const SDK_BASE_DELAY_MS = Math.round(CLIMB_MS[0] / JITTER_MEAN)
const SDK_MAX_DELAY_MS = Math.round(STEADY_MS / JITTER_MEAN)

const RETRYABLE_STATUSES = [Status.RESOURCE_EXHAUSTED, Status.UNAVAILABLE, Status.UNKNOWN, Status.INTERNAL]

/** Nominal delay before retry number `attempt` (0-based). */
export function delayForAttempt(attempt: number): number {
    return attempt < CLIMB_MS.length ? CLIMB_MS[attempt] : STEADY_MS
}

/**
 * Number of retries whose nominal delays fit into `budgetMs`. Matches the SDK's
 * `retryMaxAttempts` semantics: N means up to N + 1 calls in total.
 */
export function attemptsForBudget(budgetMs: number): number {
    let elapsed = 0
    let attempts = 0

    for (;;) {
        const delay = delayForAttempt(attempts)
        if (elapsed + delay > budgetMs) {
            return attempts
        }
        elapsed += delay
        attempts++
    }
}

export function clampBudget(budgetMs: number): number {
    if (budgetMs <= 0) {
        return 0
    }
    if (budgetMs > MAX_BUDGET_MS) {
        warning(`retry-timeout is above the ${MAX_BUDGET_MS / 60_000} minute maximum, clamping to it`)
        return MAX_BUDGET_MS
    }
    return budgetMs
}

/** Retry options for a single gRPC call, sized to `budgetMs`. */
export function grpcRetryOptions(budgetMs: number, opName: string): RetryOptions {
    const retryMaxAttempts = attemptsForBudget(budgetMs)

    return {
        retry: retryMaxAttempts > 0,
        retryBaseDelayMs: SDK_BASE_DELAY_MS,
        retryMaxDelayMs: SDK_MAX_DELAY_MS,
        retryMaxAttempts,
        retryableStatuses: RETRYABLE_STATUSES,
        onRetryableError(error, attempt, delayMs): void {
            info(
                `${opName} failed with ${Status[error.code]}: ${error.details}. ` +
                    `Retrying in ${Math.round(delayMs / 1000)}s (retry ${attempt + 1} of ${retryMaxAttempts}).`
            )
        }
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- retry.test.ts`

Expected: PASS, 10 tests.

If `attemptsForBudget(5 * 60_000)` returns something other than `6`, check the loop condition — a retry counts only when its **entire** delay fits (`elapsed + delay > budgetMs` returns, it does not round up).

- [ ] **Step 6: Verify it compiles and lints**

Run: `npm run build && npm run lint && npm run format`

Expected: no errors. `npm run build` proves the deep import of `RetryOptions` from `@yandex-cloud/nodejs-sdk/dist/middleware/retry` resolves under `NodeNext` — the codebase already deep-imports the SDK this way in `src/main.ts`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/retry.ts __tests__/retry.test.ts
git commit -m "feat: add retry schedule and gRPC retry options"
```

---

## Task 2: HTTP retry wrapper

The token exchange in `src/main.ts` is a plain axios POST, so the SDK middleware cannot cover it. This adds a wrapper using the same schedule.

**Files:**
- Modify: `src/retry.ts`
- Test: `__tests__/retry.test.ts`

**Interfaces:**
- Consumes: `delayForAttempt`, `attemptsForBudget` from Task 1.
- Produces: `withRetry<T>(fn: () => Promise<T>, budgetMs: number, opName: string, sleepFn?: (ms: number) => Promise<void>): Promise<T>`

**Why `sleepFn` is a parameter:** the real schedule starts at 10 seconds. Without an injectable sleep the tests would take minutes. Tests pass a no-op that records the requested delays; production callers omit the argument and get the real `setTimeout`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/retry.test.ts` (and extend the existing import from `../src/retry` to include `withRetry`):

```ts
import { AxiosError, AxiosHeaders } from 'axios'

function httpError(status?: number): AxiosError {
    const config = { headers: new AxiosHeaders() }
    const error = new AxiosError('request failed', 'ERR', config)
    if (status !== undefined) {
        error.response = {
            status,
            statusText: '',
            data: {},
            headers: {},
            config
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
    }
    return error
}

describe('withRetry', () => {
    const noSleep = async (): Promise<void> => {}

    test('returns the value without retrying when the call succeeds', async () => {
        let calls = 0
        const result = await withRetry(
            async () => {
                calls++
                return 'ok'
            },
            5 * 60_000,
            'Token exchange',
            noSleep
        )

        expect(result).toBe('ok')
        expect(calls).toBe(1)
    })

    test('retries a 429 and returns the eventual success', async () => {
        let calls = 0
        const result = await withRetry(
            async () => {
                calls++
                if (calls < 3) {
                    throw httpError(429)
                }
                return 'ok'
            },
            5 * 60_000,
            'Token exchange',
            noSleep
        )

        expect(result).toBe('ok')
        expect(calls).toBe(3)
    })

    test('retries a 503 and a response-less network failure', async () => {
        for (const error of [httpError(503), httpError(undefined)]) {
            let calls = 0
            await expect(
                withRetry(
                    async () => {
                        calls++
                        throw error
                    },
                    30_000,
                    'Token exchange',
                    noSleep
                )
            ).rejects.toBe(error)
            expect(calls).toBe(3) // 2 retries fit in 30s, so 3 calls
        }
    })

    test('does not retry client errors', async () => {
        for (const status of [400, 401, 403]) {
            let calls = 0
            const error = httpError(status)
            await expect(
                withRetry(
                    async () => {
                        calls++
                        throw error
                    },
                    5 * 60_000,
                    'Token exchange',
                    noSleep
                )
            ).rejects.toBe(error)
            expect(calls).toBe(1)
        }
    })

    test('does not retry non-axios errors', async () => {
        let calls = 0
        const error = new Error('boom')
        await expect(
            withRetry(
                async () => {
                    calls++
                    throw error
                },
                5 * 60_000,
                'Token exchange',
                noSleep
            )
        ).rejects.toBe(error)
        expect(calls).toBe(1)
    })

    test('stops at the budgeted number of retries and rethrows the last error', async () => {
        let calls = 0
        const error = httpError(500)
        await expect(
            withRetry(
                async () => {
                    calls++
                    throw error
                },
                5 * 60_000,
                'Token exchange',
                noSleep
            )
        ).rejects.toBe(error)

        expect(calls).toBe(7) // 6 retries + the original call
    })

    test('jitters each delay within half to full of the SDK backoff', async () => {
        const delays: number[] = []
        await expect(
            withRetry(
                async () => {
                    throw httpError(500)
                },
                70_000,
                'Token exchange',
                async ms => {
                    delays.push(ms)
                }
            )
        ).rejects.toBeDefined()

        expect(delays).toHaveLength(3)
        // Nominal 10s/20s/40s, so actual is within [nominal / 1.5, nominal / 0.75].
        for (const [index, nominal] of [10_000, 20_000, 40_000].entries()) {
            expect(delays[index]).toBeGreaterThanOrEqual(Math.floor(nominal / 1.5))
            expect(delays[index]).toBeLessThanOrEqual(Math.ceil(nominal / 0.75))
        }
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- retry.test.ts`

Expected: FAIL — `withRetry` is not exported from `../src/retry`.

- [ ] **Step 3: Write the implementation**

Add to `src/retry.ts`. The `axios` import joins the existing imports at the top of the file:

```ts
import { isAxiosError } from 'axios'
```

And append at the end of the file:

```ts
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/** Mirrors the SDK middleware's jitter so both paths behave alike. */
function jitter(nominalMs: number): number {
    return Math.round(((nominalMs / JITTER_MEAN) * (1 + Math.random())) / 2)
}

function isRetryableHttpError(error: unknown): boolean {
    if (!isAxiosError(error)) {
        return false
    }
    const status = error.response?.status
    if (status === undefined) {
        // No response arrived at all: connection reset, DNS failure, timeout.
        return true
    }
    return status === 429 || status >= 500
}

/**
 * Retries `fn` on transient HTTP failures using the same schedule as the gRPC
 * calls. Used for the token exchange, which does not go through the SDK.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    budgetMs: number,
    opName: string,
    sleepFn: (ms: number) => Promise<void> = sleep
): Promise<T> {
    const maxAttempts = attemptsForBudget(budgetMs)

    for (let attempt = 0; ; attempt++) {
        try {
            return await fn()
        } catch (error) {
            if (attempt >= maxAttempts || !isRetryableHttpError(error)) {
                throw error
            }
            const delayMs = jitter(delayForAttempt(attempt))
            info(
                `${opName} failed: ${(error as Error).message}. ` +
                    `Retrying in ${Math.round(delayMs / 1000)}s (retry ${attempt + 1} of ${maxAttempts}).`
            )
            await sleepFn(delayMs)
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- retry.test.ts`

Expected: PASS, 17 tests (10 from Task 1, 7 new).

- [ ] **Step 5: Verify it compiles and lints**

Run: `npm run build && npm run lint && npm run format`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/retry.ts __tests__/retry.test.ts
git commit -m "feat: add HTTP retry wrapper for the token exchange"
```

---

## Task 3: `retry-timeout` input

Wires the budget through configuration. This is the task that touches the existing test file, because `ActionConfig` gains a required field.

**Files:**
- Modify: `src/config.ts`
- Modify: `action.yml`
- Test: `__tests__/config.test.ts`

**Interfaces:**
- Consumes: `clampBudget` from Task 1.
- Produces:
  - `parseRetryTimeout(raw: string): number` exported from `src/config.ts`
  - `ActionConfig.retryTimeoutMs: number`

**A parsing gotcha:** `moment.duration('garbage')` does **not** throw and does **not** report `isValid() === false` — it silently yields `0`. A typo would therefore disable retries with no signal, so `parseRetryTimeout` logs an `info` line whenever the budget resolves to zero.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/config.test.ts`, and extend its existing import to `import { Config, parseRetryTimeout } from '../src/config'`:

```ts
describe('parseRetryTimeout', () => {
    test('defaults to five minutes when unset', () => {
        expect(parseRetryTimeout('')).toBe(5 * 60_000)
    })

    test('parses an ISO-8601 duration', () => {
        expect(parseRetryTimeout('PT10M')).toBe(10 * 60_000)
        expect(parseRetryTimeout('PT90S')).toBe(90_000)
    })

    test('clamps above thirty minutes instead of throwing', () => {
        expect(() => parseRetryTimeout('PT2H')).not.toThrow()
        expect(parseRetryTimeout('PT2H')).toBe(30 * 60_000)
    })

    test('treats an explicit zero as retries disabled', () => {
        expect(parseRetryTimeout('PT0S')).toBe(0)
    })

    test('treats an unparseable value as retries disabled rather than failing', () => {
        expect(() => parseRetryTimeout('not-a-duration')).not.toThrow()
        expect(parseRetryTimeout('not-a-duration')).toBe(0)
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- config.test.ts`

Expected: FAIL — `parseRetryTimeout` is not exported from `../src/config`.

- [ ] **Step 3: Add the field and the parser to `src/config.ts`**

Extend the imports on line 1 to include `info`, and add the retry import:

```ts
import { startGroup, getInput, getBooleanInput, endGroup, info } from '@actions/core'
import { clampBudget } from './retry'
```

Add the field to the `ActionConfig` interface, directly after `disableUpdate: boolean`:

```ts
    retryTimeoutMs: number
```

Add the exported parser above `parseVmInputs`:

```ts
const DEFAULT_RETRY_TIMEOUT = 'PT5M'

/**
 * Parses the `retry-timeout` input into a millisecond budget.
 *
 * Values above the internal maximum are clamped, not rejected: an oversized
 * budget must never fail the job at startup. `moment.duration` yields 0 for
 * unparseable input rather than throwing, so a typo disables retries; the
 * info line below makes that visible in the job log.
 */
export function parseRetryTimeout(raw: string): number {
    const budgetMs = clampBudget(moment.duration(raw || DEFAULT_RETRY_TIMEOUT).asMilliseconds())

    if (budgetMs === 0) {
        info('Retries are disabled: retry-timeout resolves to a zero duration')
    }

    return budgetMs
}
```

Inside `parseVmInputs`, add the read next to the other optional inputs (after the `disableUpdate` line):

```ts
    const retryTimeoutMs: number = parseRetryTimeout(getInput('retry-timeout', { required: false }))
```

And add `retryTimeoutMs` to the returned object literal, after `disableUpdate`:

```ts
        disableUpdate,
        retryTimeoutMs,
```

- [ ] **Step 4: Add the required field to the three existing config tests**

`ActionConfig.retryTimeoutMs` is required, so the three object literals in `__tests__/config.test.ts` no longer typecheck. In **each** of the `basic Config`, `add secondary disk`, and `add secondary disk without image-id throw error` tests, add this line directly after `disableUpdate: false,`:

```ts
            retryTimeoutMs: 5 * 60_000,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- config.test.ts`

Expected: PASS, 8 tests. If TypeScript reports `Property 'retryTimeoutMs' is missing`, one of the three literals in Step 4 was missed.

- [ ] **Step 6: Declare the input in `action.yml`**

Insert after the `disable-update` block (before the blank line preceding `user:`):

```yaml
  retry-timeout:
    required: false
    description: >-
      How long to keep retrying transient Yandex Cloud errors, in ISO 8601 Duration format. E.g. PT5M.
      Retries back off 10s, 20s, 40s, then every minute, with jitter.
      Set to PT0S to disable retries. Values above PT30M are clamped to PT30M.
      This is a target rather than a hard deadline: jitter and in-flight requests can overshoot it.
    default: 'PT5M'
```

- [ ] **Step 7: Verify the full suite, build and lint**

Run: `npm run build && npm run lint && npm run format && npm test`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts action.yml __tests__/config.test.ts
git commit -m "feat: add retry-timeout input"
```

---

## Task 4: Retry VM create and delete

**Files:**
- Modify: `src/main.ts` (the `instanceService.create` call at ~line 152, the `instanceService.delete` call at ~line 207)

**Interfaces:**
- Consumes: `grpcRetryOptions` (Task 1), `config.input.retryTimeoutMs` (Task 3).
- Produces: nothing consumed by later tasks.

**Why the idempotency key matters here:** we retry on `UNAVAILABLE` and `UNKNOWN`, which — unlike `RESOURCE_EXHAUSTED` — can mean the request *succeeded* but its response was lost. Without a key, that retry would create a second VM that no output tracks: a billed instance running a live runner token that nothing will ever stop. Yandex Cloud's `Idempotency-Key` header (a v4 UUID) makes the repeat return the existing Operation instead. The key must be created **before** the call so that all attempts share it; the SDK middleware forwards `metadata` unchanged to each attempt.

There is no test step in this task. The repository has no SDK mocking infrastructure and the existing suite is pure-function only (see `__tests__/main.test.ts`, which tests `buildUserDataScript` and nothing else); adding a gRPC test double for two call sites is out of scope for this change. The correctness of the options object is covered by Task 1's tests. Verification here is the build plus review.

- [ ] **Step 1: Add the imports to `src/main.ts`**

Add alongside the existing imports:

```ts
import { randomUUID } from 'node:crypto'
import { Metadata } from 'nice-grpc'
import { grpcRetryOptions, withRetry } from './retry'
```

(`withRetry` is unused until Task 5. If your linter rejects that, add it in Task 5 instead.)

- [ ] **Step 2: Pass retry options and an idempotency key to `create`**

In `createVm`, replace the `const op = await instanceService.create(...)` call. The request body is unchanged — only the second argument is new:

```ts
    const idempotencyKey = randomUUID()

    const op = await instanceService.create(
        CreateInstanceRequest.fromPartial({
            folderId: config.input.folderId,
            description: `Runner for: ${repo.owner}/${repo.repo}`,
            zoneId: config.input.zoneId,
            platformId: config.input.platformId,
            resourcesSpec: config.input.resourcesSpec,
            metadata: {
                'user-data': buildUserDataScript({
                    githubRegistrationToken,
                    label,
                    runnerHomeDir: config.input.runnerHomeDir,
                    user: config.input.user,
                    sshPublicKey: config.input.sshPublicKey,
                    repo: config.githubContext.repo,
                    owner: config.githubContext.owner,
                    runnerVersion: config.input.runnerVersion,
                    disableUpdate: config.input.disableUpdate
                }).join('\n')
            },
            labels,

            bootDiskSpec: {
                mode: AttachedDiskSpec_Mode.READ_WRITE,
                autoDelete: true,
                diskSpec: {
                    typeId: config.input.diskType,
                    size: config.input.diskSize,
                    imageId: config.input.imageId
                }
            },
            secondaryDiskSpecs,
            networkInterfaceSpecs: [networkInterfaceSpec],
            serviceAccountId: config.input.serviceAccountId
        }),
        {
            ...grpcRetryOptions(config.input.retryTimeoutMs, 'Create instance'),
            // Generated once, outside the call, so every retry carries the same key
            // and a lost response cannot produce a second VM.
            metadata: Metadata({ 'idempotency-key': idempotencyKey })
        }
    )
```

- [ ] **Step 3: Do the same for `delete`**

In `destroyVm`, replace the `const op = await instanceService.delete(...)` call:

```ts
    const idempotencyKey = randomUUID()

    const op = await instanceService.delete(
        DeleteInstanceRequest.fromPartial({
            instanceId: config.input.instanceId
        }),
        {
            ...grpcRetryOptions(config.input.retryTimeoutMs, 'Delete instance'),
            metadata: Metadata({ 'idempotency-key': idempotencyKey })
        }
    )
```

- [ ] **Step 4: Verify it compiles and the suite still passes**

Run: `npm run build && npm run lint && npm run format && npm test`

Expected: no errors, all tests pass. If TypeScript rejects the second argument, confirm the client type is `WrappedServiceClientType`, whose call options are `DeadlineOptions & RetryOptions` plus the base `CallOptions` that supply `metadata`.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: retry VM create and delete with an idempotency key"
```

---

## Task 5: Retry the token exchange

**Files:**
- Modify: `src/main.ts` (`exchangeToken` at ~line 295, and its caller at ~line 263)

**Interfaces:**
- Consumes: `withRetry` (Task 2), `config.input.retryTimeoutMs` (Task 3).
- Produces: nothing consumed by later tasks.

**Note on the dead branch:** `exchangeToken` currently checks `if (res.status !== 200)`. Axios rejects on non-2xx by default and this code never customizes `validateStatus`, so that branch is unreachable. `withRetry`'s error classification replaces it, and it is removed here as the spec specifies.

**On the SDK's own IAM token fetch:** `Session` creates IAM tokens internally and accepts no call options, so it cannot be wrapped directly. It is covered transitively — a token failure rejects the credentials metadata generator, which surfaces as `UNAVAILABLE`/`UNKNOWN` on the outer `create`/`delete` call, which Task 4 now retries. No code change is needed or possible here.

- [ ] **Step 1: Add the budget parameter and wrap the POST**

Replace `exchangeToken` in its entirety:

```ts
async function exchangeToken(token: string, saId: string, retryTimeoutMs: number): Promise<string> {
    info(`Exchanging token for service account ${saId}`)
    const res = await withRetry(
        () =>
            axios.post(
                'https://auth.yandex.cloud/oauth/token',
                {
                    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
                    audience: saId,
                    subject_token: token,
                    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
                },
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            ),
        retryTimeoutMs,
        'Token exchange'
    )
    if (!res.data.access_token) {
        throw new Error(`Failed to exchange token: ${res.data.error} ${res.data.error_description}`)
    }
    info(`Token exchanged successfully`)
    return res.data.access_token
}
```

- [ ] **Step 2: Update the call site**

In `run()`, pass the budget:

```ts
            const saToken = await exchangeToken(ghToken, ycSaId, config.input.retryTimeoutMs)
```

- [ ] **Step 3: Verify it compiles and the suite still passes**

Run: `npm run build && npm run lint && npm run format && npm test`

Expected: no errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: retry the workload identity token exchange"
```

---

## Task 6: Documentation and bundle

`dist/` is committed and is what GitHub actually executes — the feature does not ship until it is rebuilt.

**Files:**
- Modify: `README.md`
- Modify: `dist/` (generated)

**Interfaces:**
- Consumes: everything above.
- Produces: the shipped artifact.

- [ ] **Step 1: Document the input in `README.md`**

Add a section directly after the existing `### TTL input` section (which ends with the line about Cron triggers), matching its style:

```markdown
### Retry timeout input

Yandex Cloud rejects requests with `RESOURCE_EXHAUSTED` when too many operations are already
running in the cloud, which is common when many jobs start at once. The action retries such
failures instead of failing the job immediately.

`retry-timeout` sets how long to keep retrying, in ISO 8601 Duration format. It defaults to `PT5M`.
Set it to `PT0S` to disable retries. Values above `PT30M` are clamped to `PT30M`.

Retries back off 10s, 20s, 40s and then every minute, with jitter so that concurrent jobs do not
retry in lockstep. Each create and delete request carries an `Idempotency-Key`, so a retry can
never create a second VM.

The timeout is a target rather than a hard deadline: jitter and in-flight requests can overshoot it
by roughly a third.
```

- [ ] **Step 2: Run the whole pipeline**

Run: `npm run all`

This runs build, format, lint, package and test in sequence. Expected: all steps succeed and `dist/index.js` is regenerated.

- [ ] **Step 3: Confirm the bundle actually changed**

Run: `git status --short dist`

Expected: `dist/index.js` and `dist/index.js.map` show as modified. If `dist/` is unchanged, `npm run package` did not pick up the new code — rerun `npm run build && npm run package`.

- [ ] **Step 4: Commit**

```bash
git add README.md dist
git commit -m "docs: document retry-timeout and rebuild the bundle"
```

- [ ] **Step 5: Final verification**

Run: `npm test && git status --short`

Expected: all tests pass and the working tree is clean.
