import { expect, test } from '@jest/globals'
import { Config } from '../src/config'
import { parseMemory } from '../src/memory'

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
            resourcesSpec: {
                cores: 1,
                memory: parseMemory('8Gb'),
                coreFraction: 100
            }
        })
    }).toThrowErrorMatchingSnapshot()
})
