import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { warning } from '@actions/core'
import { Status } from 'nice-grpc'
import { attemptsForBudget, clampBudget, delayForAttempt, grpcRetryOptions, MAX_BUDGET_MS } from '../src/retry'

jest.mock('@actions/core')

const mockedWarning = jest.mocked(warning)

beforeEach(() => {
    mockedWarning.mockClear()
})

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
        expect(mockedWarning).toHaveBeenCalledWith(
            `retry-timeout is above the ${MAX_BUDGET_MS / 60_000} minute maximum, clamping to it`
        )
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
