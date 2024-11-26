import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseMemory } from './memory'
import moment from 'moment'

export interface ResourcesSpec {
    memory: number
    cores: number
    coreFraction: number
}

export interface ActionConfig {
    imageId: string
    mode: string
    githubToken: string
    runnerHomeDir: string
    label: string
    subnetId: string
    publicIp: boolean
    serviceAccountId: string
    diskType: string
    diskSize: number
    folderId: string
    zoneId: string
    platformId: string
    resourcesSpec: ResourcesSpec

    secondDiskImageId: string
    secondDiskType: string
    secondDiskSize: number

    user: string
    sshPublicKey: string

    instanceId?: string

    runnerVersion: string
    ttl?: moment.Duration
    disableUpdate: boolean
}

export interface GithubRepo {
    owner: string
    repo: string
}

export class Config {
    input: ActionConfig
    githubContext: GithubRepo

    constructor(input?: ActionConfig) {
        this.input = input ?? parseVmInputs()

        // the values of github.context.repo.owner and github.context.repo.repo are taken from
        // the environment variable GITHUB_REPOSITORY specified in "owner/repo" format and
        // provided by the GitHub Action on the runtime
        this.githubContext = {
            owner: github.context.repo.owner,
            repo: github.context.repo.repo
        }

        //
        // validate input
        //

        if (!this.input.mode) {
            throw new Error(`The 'mode' input is not specified`)
        }

        if (!this.input.githubToken) {
            throw new Error(`The 'github-token' input is not specified`)
        }

        if (this.input.mode === 'start') {
            if (!this.input.imageId || !this.input.subnetId || !this.input.folderId) {
                throw new Error(`Not all the required inputs are provided for the 'start' mode`)
            }

            if (this.input.secondDiskSize > 0 && !this.input.secondDiskImageId) {
                throw new Error(`Secondary disk image id is missing`)
            }
        } else if (this.input.mode === 'stop') {
            if (!this.input.label || !this.input.instanceId) {
                throw new Error(`Not all the required inputs are provided for the 'stop' mode`)
            }
        } else {
            throw new Error('Wrong mode. Allowed values: start, stop.')
        }
    }

    generateUniqueLabel(): string {
        return Math.random().toString(36).slice(2, 7)
    }
}

function parseVmInputs(): ActionConfig {
    core.startGroup('Parsing Action Inputs')

    const folderId: string = core.getInput('folder-id')

    const mode = core.getInput('mode')
    const githubToken = core.getInput('github-token')
    const runnerHomeDir = core.getInput('runner-home-dir')
    const label = core.getInput('label')

    const serviceAccountId: string = core.getInput('service-account-id')

    const imageId: string = core.getInput('image-id')
    const zoneId: string = core.getInput('zone-id') || 'ru-central1-a'
    const subnetId: string = core.getInput('subnet-id')
    const publicIp: boolean = core.getBooleanInput('public-ip', { required: false })
    const platformId: string = core.getInput('platform-id') || 'standard-v3'
    const cores: number = parseInt(core.getInput('cores') || '2', 10)
    const memory: number = parseMemory(core.getInput('memory') || '1Gb')
    const diskType: string = core.getInput('disk-type') || 'network-ssd'
    const diskSize: number = parseMemory(core.getInput('disk-size') || '30Gb')
    const coreFraction: number = parseInt(core.getInput('core-fraction') || '100', 10)

    const secondDiskImageId: string = core.getInput('image2-id')
    const secondDiskType: string = core.getInput('disk2-type') || 'network-ssd'
    const secondDiskSize: number = parseMemory(core.getInput('disk2-size') || '0Gb')

    const user: string = core.getInput('user')
    const sshPublicKey: string = core.getInput('ssh-public-key')

    const instanceId: string = core.getInput('instance-id', { required: false })

    const runnerVersion: string = core.getInput('runner-version', { required: false })
    const disableUpdate: boolean = core.getBooleanInput('disable-update', { required: false })

    let ttl: moment.Duration | undefined = undefined
    const ttlInput = core.getInput('ttl', { required: false })
    if (ttlInput) {
        ttl = moment.duration(ttlInput)
    }

    core.endGroup()
    return {
        instanceId,
        imageId,
        diskType,
        diskSize,
        subnetId,
        publicIp,
        zoneId,
        platformId,
        folderId,
        mode,
        githubToken,
        runnerHomeDir,
        label,
        serviceAccountId,
        secondDiskImageId,
        secondDiskType,
        secondDiskSize,
        user,
        sshPublicKey,
        runnerVersion,
        ttl,
        disableUpdate,
        resourcesSpec: {
            cores,
            memory,
            coreFraction
        }
    }
}
