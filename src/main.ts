import axios from 'axios'
import {
    endGroup,
    error as core_error,
    getIDToken,
    getInput,
    info,
    setCommandEcho,
    setFailed,
    setOutput,
    startGroup
} from '@actions/core'
import { context } from '@actions/github'
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
import { dump, load } from 'js-yaml'
import { Config, GithubRepo } from './config'
import { getRegistrationToken, removeRunner, waitForRunnerRegistered } from './gh'
import { fromServiceAccountJsonFile } from './service-account-json'
import moment from 'moment'
import { SessionConfig } from '@yandex-cloud/nodejs-sdk/dist/types'

let config: Config

try {
    config = new Config()
} catch (error) {
    const err = error as Error
    core_error(err)
    setFailed(err.message)
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
    disableUpdate: boolean
}

// User data scripts are run as the root user
export function buildUserDataScript(params: BuildUserDataScriptParams): string[] {
    const { githubRegistrationToken, label, runnerHomeDir, repo, owner, user, sshPublicKey } = params
    let script: string[]

    if (runnerHomeDir) {
        // If runner home directory is specified, we expect the actions-runner software (and dependencies)
        // to be pre-installed in the image, so we simply cd into that directory and then start the runner
        script = [
            '#!/bin/bash',
            `cd "${runnerHomeDir}"`,
            'export RUNNER_ALLOW_RUNASROOT=1',
            `./config.sh --url https://github.com/${owner}/${repo} --token ${githubRegistrationToken} --labels ${label}${params.disableUpdate ? ' --disableupdate' : ''}`,
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
            `./config.sh --url https://github.com/${owner}/${repo} --token ${githubRegistrationToken} --labels ${label}${params.disableUpdate ? ' --disableupdate' : ''}`,
            './run.sh'
        ]
    }
    if (user !== '' && sshPublicKey !== '') {
        const cloudInit = load(`ssh_pwauth: no
users:
  - name: ${user}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - "${sshPublicKey}"`) as Record<string, unknown>
        cloudInit['runcmd'] = script.slice(1)
        return ['#cloud-config', ...dump(cloudInit).split('\n')]
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
    startGroup('Create VM')

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
        })
    )
    const finishedOp = await waitForOperation(op, session)
    if (finishedOp.response) {
        const instanceId = decodeMessage<Instance>(finishedOp.response).id
        info(`Created instance with id '${instanceId}'`)
        endGroup()
        return instanceId
    } else {
        core_error(`Failed to create instance'`)
        endGroup()
        throw new Error('Failed to create instance')
    }
}

async function destroyVm(
    session: Session,
    instanceService: WrappedServiceClientType<typeof InstanceServiceService>
): Promise<void> {
    startGroup('Create VM')

    const op = await instanceService.delete(
        DeleteInstanceRequest.fromPartial({
            instanceId: config.input.instanceId
        })
    )
    const finishedOp = await waitForOperation(op, session)
    if (finishedOp.metadata) {
        const instanceId = decodeMessage<CreateInstanceMetadata>(finishedOp.metadata).instanceId
        info(`Destroyed instance with id '${instanceId}'`)
    } else {
        core_error(`Failed to create instance'`)
        throw new Error('Failed to create instance')
    }
    endGroup()
}

async function start(
    session: Session,
    instanceService: WrappedServiceClientType<typeof InstanceServiceService>
): Promise<void> {
    const label = config.generateUniqueLabel()
    const githubRegistrationToken = await getRegistrationToken(config)
    const instanceId = await createVm(session, instanceService, context.repo, githubRegistrationToken, label)
    setOutput('label', label)
    setOutput('instance-id', instanceId)
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
    setCommandEcho(true)
    try {
        info(`start`)
        let sessionConfig: SessionConfig = {}
        const ycSaJsonCredentials = getInput('yc-sa-json-credentials')
        const ycIamToken = getInput('yc-iam-token')
        const ycSaId = getInput('yc-sa-id')
        if (ycSaJsonCredentials !== '') {
            const serviceAccountJson = fromServiceAccountJsonFile(JSON.parse(ycSaJsonCredentials))
            info('Parsed Service account JSON')
            sessionConfig = { serviceAccountJson }
        } else if (ycIamToken !== '') {
            sessionConfig = { iamToken: ycIamToken }
            info('Using IAM token')
        } else if (ycSaId !== '') {
            const ghToken = await getIDToken()
            if (!ghToken) {
                throw new Error('No credentials provided')
            }
            const saToken = await exchangeToken(ghToken, ycSaId)
            sessionConfig = { iamToken: saToken }
        } else {
            throw new Error('No credentials')
        }
        const session = new Session(sessionConfig)

        info(`Folder ID: ${config.input.folderId}`)

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
            core_error(`${error.message}\nx-request-id: ${error.requestId}\nx-server-trace-id: ${error.serverTraceId}`)
        }
        setFailed(error as Error)
    }
}

async function exchangeToken(token: string, saId: string): Promise<string> {
    info(`Exchanging token for service account ${saId}`)
    const res = await axios.post(
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
    )
    if (res.status !== 200) {
        throw new Error(`Failed to exchange token: ${res.status} ${res.statusText}`)
    }
    if (!res.data.access_token) {
        throw new Error(`Failed to exchange token: ${res.data.error} ${res.data.error_description}`)
    }
    info(`Token exchanged successfully`)
    return res.data.access_token
}

run()
