import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import { info, warning } from '@actions/core'
import { Config, parseRetryTimeout } from '../src/config'
import { parseMemory } from '../src/memory'

jest.mock('@actions/core')

const mockedWarning = jest.mocked(warning)
const mockedInfo = jest.mocked(info)

beforeEach(() => {
    mockedWarning.mockClear()
    mockedInfo.mockClear()
})

test('basic Config', () => {
    expect(() => {
        new Config({
            instanceId: 'instanceId',
            imageId: 'imageId',
            diskType: 'diskType',
            diskSize: 10 * 1024 ** 3,
            subnetId: 'subnetId',
            publicIp: true,
            zoneId: 'zoneId',
            platformId: 'platformId',
            folderId: 'folderId',
            mode: 'start',
            githubToken: 'githubToken',
            runnerHomeDir: 'runnerHomeDir',
            label: 'label',
            serviceAccountId: 'serviceAccountId',
            secondDiskImageId: '',
            secondDiskType: '',
            secondDiskSize: 0,
            user: '',
            sshPublicKey: '',
            runnerVersion: '2.299.1',
            disableUpdate: false,
            retryTimeoutMs: 5 * 60_000,
            resourcesSpec: {
                cores: 1,
                memory: 10 * 1024 ** 3,
                coreFraction: 100
            }
        })
    }).not.toThrow()
})

test('add secondary disk', () => {
    expect(() => {
        new Config({
            instanceId: 'instanceId',
            imageId: 'imageId',
            diskType: 'diskType',
            diskSize: parseMemory('256Gb'),
            subnetId: 'subnetId',
            publicIp: true,
            zoneId: 'zoneId',
            platformId: 'platformId',
            folderId: 'folderId',
            mode: 'start',
            githubToken: 'githubToken',
            runnerHomeDir: 'runnerHomeDir',
            label: 'label',
            serviceAccountId: 'serviceAccountId',
            secondDiskImageId: 'secondDiskImageId',
            secondDiskType: 'secondDiskType',
            secondDiskSize: parseMemory('30Gb'),
            user: '',
            sshPublicKey: '',
            runnerVersion: '2.299.1',
            disableUpdate: false,
            retryTimeoutMs: 5 * 60_000,
            resourcesSpec: {
                cores: 1,
                memory: parseMemory('8Gb'),
                coreFraction: 100
            }
        })
    }).not.toThrow()
})

test('add secondary disk without image-id throw error', () => {
    expect(() => {
        new Config({
            instanceId: 'instanceId',
            imageId: 'imageId',
            diskType: 'diskType',
            diskSize: parseMemory('256Gb'),
            subnetId: 'subnetId',
            publicIp: true,
            zoneId: 'zoneId',
            platformId: 'platformId',
            folderId: 'folderId',
            mode: 'start',
            githubToken: 'githubToken',
            runnerHomeDir: 'runnerHomeDir',
            label: 'label',
            serviceAccountId: 'serviceAccountId',
            secondDiskImageId: '',
            secondDiskType: 'secondDiskType',
            secondDiskSize: parseMemory('30Gb'),
            user: 'user',
            sshPublicKey: 'sshPublicKey',
            runnerVersion: '2.299.1',
            disableUpdate: false,
            retryTimeoutMs: 5 * 60_000,
            resourcesSpec: {
                cores: 1,
                memory: parseMemory('8Gb'),
                coreFraction: 100
            }
        })
    }).toThrowErrorMatchingSnapshot()
})

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
        expect(mockedWarning).toHaveBeenCalledWith('retry-timeout is above the 30 minute maximum, clamping to it')
    })

    test('treats an explicit zero as retries disabled', () => {
        expect(parseRetryTimeout('PT0S')).toBe(0)
        expect(mockedInfo).toHaveBeenCalledWith('Retries are disabled: retry-timeout resolves to a zero duration')
    })

    test('treats an unparseable value as retries disabled rather than failing', () => {
        expect(() => parseRetryTimeout('not-a-duration')).not.toThrow()
        expect(parseRetryTimeout('not-a-duration')).toBe(0)
        expect(mockedInfo).toHaveBeenCalledWith('Retries are disabled: retry-timeout resolves to a zero duration')
    })
})
