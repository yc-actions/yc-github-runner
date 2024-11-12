import * as core from '@actions/core'
import * as github from '@actions/github'
import {
    decodeMessage,
    errors,
    serviceClients,
    Session,
    waitForOperation,
    WrappedServiceClientType
} from '@yandex-cloud/nodejs-sdk'
import { Instance, IpVersion } from '@yandex-cloud/nodejs-sdk/dist/generated/yandex/cloud/compute/v1/instance'
import {
    AttachedDiskSpec,
    AttachedDiskSpec_Mode,
    CreateInstanceMetadata,
    CreateInstanceRequest,
    DeleteInstanceRequest,
    InstanceServiceService,
    NetworkInterfaceSpec
} from '@yandex-cloud/nodejs-sdk/dist/generated/yandex/cloud/compute/v1/instance_service'
import * as yaml from 'js-yaml'
import { Config, GithubRepo } from './config'
import { getRegistrationToken, removeRunner, waitForRunnerRegistered } from './gh'
import { fromServiceAccountJsonFile } from './service-account-json'
import moment from 'moment'

let config: Config

try {
    config = new Config()
} catch (error) {
    const err = error as Error
    core.error(err)
    core.setFailed(err.message)
}

interface BuildUserDataScriptParams {
    githubRegistrationToken: string
    label: string
    runnerHomeDir: string
    owner: string
    repo: string
    user: string
    sshPublicKey: string
    runnerVersion: string
}

// User data scripts are run as the root user
export function buildUserDataScript(params: BuildUserDataScriptParams): string[] {
    const { githubRegistrationToken, label, runnerHomeDir, repo, owner, user, sshPublicKey } = params
    let script: string[]
    /*eslint-disable max-len*/
    if (runnerHomeDir) {
        // If runner home directory is specified, we expect the actions-runner software (and dependencies)
        // to be pre-installed in the image, so we simply cd into that directory and then start the runner
        script = [
            '#!/bin/bash',
            `cd "${runnerHomeDir}"`,
            'export RUNNER_ALLOW_RUNASROOT=1',
            `./config.sh --url https://github.com/${owner}/${repo} --token ${githubRegistrationToken} --labels ${label}`,
            './run.sh'
        ]
    } else {
        const version = params.runnerVersion
        script = [
            '#!/bin/bash',
            'mkdir actions-runner && cd actions-runner',
            'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
            `curl -O -L https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-\${RUNNER_ARCH}-${version}.tar.gz`,
            `tar xzf ./actions-runner-linux-\${RUNNER_ARCH}-${version}.tar.gz`,
            'export RUNNER_ALLOW_RUNASROOT=1',
            `./config.sh --url https://github.com/${owner}/${repo} --token ${githubRegistrationToken} --labels ${label}`,
            './run.sh'
        ]
    }
    if (user !== '' && sshPublicKey !== '') {
        const cloudInit = yaml.load(`ssh_pwauth: no
users:
  - name: ${user}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - "${sshPublicKey}"`) as Record<string, unknown>
        cloudInit['runcmd'] = script.slice(1)
        return ['#cloud-config', ...yaml.dump(cloudInit).split('\n')]
    } else {
        return script
    }
}

async function createVm(
    session: Session,
    instanceService: WrappedServiceClientType<typeof InstanceServiceService>,
    repo: GithubRepo,
    githubRegistrationToken: string,
    label: string
): Promise<string> {
    core.startGroup('Create VM')

    const secondaryDiskSpecs: AttachedDiskSpec[] = []

    if (config.input.secondDiskSize > 0) {
        secondaryDiskSpecs.push(
            AttachedDiskSpec.fromPartial({
                autoDelete: true,
                mode: AttachedDiskSpec_Mode.READ_WRITE,
                diskSpec: {
                    imageId: config.input.secondDiskImageId,
                    size: config.input.secondDiskSize,
                    typeId: config.input.secondDiskType
                }
            })
        )
    }
    let primaryV4AddressSpec = {}

    if (config.input.publicIp) {
        primaryV4AddressSpec = {
            oneToOneNatSpec: {
                ipVersion: IpVersion.IPV4
            }
        }
    }

    const networkInterfaceSpec = NetworkInterfaceSpec.fromPartial({
        subnetId: config.input.subnetId,
        primaryV4AddressSpec
    })

    const labels: Record<string, string> = {}

    if (config.input.ttl) {
        // Set `expires` label to the current time + TTL Duration
        // Instance won't automatically be destroyed by Yandex.Cloud, you should handle it yourself
        // For example, by using Cron trigger that will call Cloud Function to destroy the instance.
        labels['expires'] = moment.utc().add(config.input.ttl).unix().toString()
    }

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
                    runnerVersion: config.input.runnerVersion
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
        })
    )
    const finishedOp = await waitForOperation(op, session)
    if (finishedOp.response) {
        const instanceId = decodeMessage<Instance>(finishedOp.response).id
        core.info(`Created instance with id '${instanceId}'`)
        core.endGroup()
        return instanceId
    } else {
        core.error(`Failed to create instance'`)
        core.endGroup()
        throw new Error('Failed to create instance')
    }
}

async function destroyVm(
    session: Session,
    instanceService: WrappedServiceClientType<typeof InstanceServiceService>
): Promise<void> {
    core.startGroup('Create VM')

    const op = await instanceService.delete(
        DeleteInstanceRequest.fromPartial({
            instanceId: config.input.instanceId
        })
    )
    const finishedOp = await waitForOperation(op, session)
    if (finishedOp.metadata) {
        const instanceId = decodeMessage<CreateInstanceMetadata>(finishedOp.metadata).instanceId
        core.info(`Destroyed instance with id '${instanceId}'`)
    } else {
        core.error(`Failed to create instance'`)
        throw new Error('Failed to create instance')
    }
    core.endGroup()
}

async function start(
    session: Session,
    instanceService: WrappedServiceClientType<typeof InstanceServiceService>
): Promise<void> {
    const label = config.generateUniqueLabel()
    const githubRegistrationToken = await getRegistrationToken(config)
    const instanceId = await createVm(session, instanceService, github.context.repo, githubRegistrationToken, label)
    core.setOutput('label', label)
    core.setOutput('instance-id', instanceId)
    await waitForRunnerRegistered(config, label)
}

async function stop(
    session: Session,
    instanceService: WrappedServiceClientType<typeof InstanceServiceService>
): Promise<void> {
    await destroyVm(session, instanceService)
    await removeRunner(config)
}

async function run(): Promise<void> {
    core.setCommandEcho(true)
    try {
        core.info(`start`)
        const ycSaJsonCredentials = core.getInput('yc-sa-json-credentials', {
            required: true
        })

        core.info(`Folder ID: ${config.input.folderId}`)

        const serviceAccountJson = fromServiceAccountJsonFile(JSON.parse(ycSaJsonCredentials))
        core.info('Parsed Service account JSON')

        const session = new Session({ serviceAccountJson })
        const instanceService = session.client(serviceClients.InstanceServiceClient)

        switch (config.input.mode) {
            case 'start': {
                await start(session, instanceService)
                break
            }
            case 'stop': {
                await stop(session, instanceService)
                break
            }
            default:
                // noinspection ExceptionCaughtLocallyJS
                throw new Error(`Unknown mode ${config.input.mode}`)
        }
    } catch (error) {
        if (error instanceof errors.ApiError) {
            core.error(`${error.message}\nx-request-id: ${error.requestId}\nx-server-trace-id: ${error.serverTraceId}`)
        }
        core.setFailed(error as Error)
    }
}

run()
