import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { info, warning } from '@actions/core'
import { AxiosError, AxiosHeaders } from 'axios'
import { ClientError, Status } from 'nice-grpc'
import {
    attemptsForBudget,
    clampBudget,
    delayForAttempt,
    grpcRetryOptions,
    MAX_BUDGET_MS,
    withRetry
} from '../src/retry'

jest.mock('@actions/core')

const mockedWarning = jest.mocked(warning)
const mockedInfo = jest.mocked(info)

beforeEach(() => {
    mockedWarning.mockClear()
    mockedInfo.mockClear()
})

describe('delayForAttempt', () => {
    test('doubles from a second up to a minute, then stays there', () => {
        expect(delayForAttempt(0)).toBe(1_000)
        expect(delayForAttempt(1)).toBe(2_000)
        expect(delayForAttempt(2)).toBe(4_000)
        expect(delayForAttempt(3)).toBe(8_000)
        expect(delayForAttempt(4)).toBe(16_000)
        expect(delayForAttempt(5)).toBe(32_000)
        expect(delayForAttempt(6)).toBe(60_000)
        expect(delayForAttempt(7)).toBe(60_000)
        expect(delayForAttempt(50)).toBe(60_000)
    })
})

describe('attemptsForBudget', () => {
    test('no budget means no retries', () => {
        expect(attemptsForBudget(0)).toBe(0)
        expect(attemptsForBudget(-1)).toBe(0)
    })

    test('a retry is only counted if its whole delay fits', () => {
        expect(attemptsForBudget(999)).toBe(0)
        expect(attemptsForBudget(1_000)).toBe(1)
        expect(attemptsForBudget(2_999)).toBe(1)
        expect(attemptsForBudget(3_000)).toBe(2)
    })

    test('matches the documented budget table', () => {
        expect(attemptsForBudget(5 * 60_000)).toBe(9)
        expect(attemptsForBudget(10 * 60_000)).toBe(14)
        expect(attemptsForBudget(30 * 60_000)).toBe(34)
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

        // 1333 * 0.75 = 1s, doubling through to 32s; 80000 * 0.75 = 60s thereafter.
        expect(options.retryBaseDelayMs).toBe(1_333)
        expect(options.retryMaxDelayMs).toBe(80_000)
        expect(options.retry).toBe(true)
        expect(options.retryMaxAttempts).toBe(9)
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

    test('onRetryableError logs the status, details, and retry progress', () => {
        const options = grpcRetryOptions(5 * 60_000, 'Create instance')
        const error = new ClientError(
            '/yandex.cloud.compute.v1.InstanceService/Create',
            Status.RESOURCE_EXHAUSTED,
            'The limit on maximum number of active operations has exceeded'
        )

        options.onRetryableError?.(error, 0, 1_000)

        expect(mockedInfo).toHaveBeenCalledWith(
            'Create instance failed with RESOURCE_EXHAUSTED: The limit on maximum number of active operations has exceeded. ' +
                'Retrying in 1s (retry 1 of 9).'
        )
    })
})

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
                    3_000,
                    'Token exchange',
                    noSleep
                )
            ).rejects.toBe(error)
            expect(calls).toBe(3) // 2 retries fit in 3s, so 3 calls
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

        expect(calls).toBe(10) // 9 retries + the original call
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

        expect(delays).toHaveLength(6)
        // Nominal 1s..32s, so actual is within [nominal / 1.5, nominal / 0.75].
        for (const [index, nominal] of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000].entries()) {
            expect(delays[index]).toBeGreaterThanOrEqual(Math.floor(nominal / 1.5))
            expect(delays[index]).toBeLessThanOrEqual(Math.ceil(nominal / 0.75))
        }
    })
})
