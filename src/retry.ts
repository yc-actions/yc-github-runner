import { info, warning } from '@actions/core'
import { RetryOptions } from '@yandex-cloud/nodejs-sdk/dist/middleware/retry'
import { isAxiosError } from 'axios'
import { Status } from 'nice-grpc'

/**
 * Nominal backoff schedule: 1s -> 2s -> 4s -> 8s -> 16s -> 32s -> 60s -> 60s -> ...
 * A doubling climb from a second up to a minute, then a fixed one-minute interval.
 * The first steps are short so a brief hiccup costs a second rather than ten.
 */
const CLIMB_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]
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
