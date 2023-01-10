import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  decodeMessage,
  serviceClients,
  Session,
  waitForOperation,
  WrappedServiceClientType,
} from '@yandex-cloud/nodejs-sdk';
import {IpVersion} from '@yandex-cloud/nodejs-sdk/dist/generated/yandex/cloud/compute/v1/instance';
import {
  AttachedDiskSpec_Mode,
  CreateInstanceMetadata,
  CreateInstanceRequest,
  DeleteInstanceRequest,
  InstanceServiceService,
} from '@yandex-cloud/nodejs-sdk/dist/generated/yandex/cloud/compute/v1/instance_service';
import {Config, GithubRepo} from './config';
import {getRegistrationToken, removeRunner, waitForRunnerRegistered} from './gh';
import {fromServiceAccountJsonFile} from './service-account-json';

let config: Config;

try {
  config = new Config();
} catch (error) {
  const err = error as Error;
  core.error(err);
  core.setFailed(err.message);
}

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken: string, label: string): string[] {
  /*eslint-disable max-len*/
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the image, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.299.1/actions-runner-linux-${RUNNER_ARCH}-2.299.1.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.299.1.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
}

async function createVm(
  session: Session,
  instanceService: WrappedServiceClientType<typeof InstanceServiceService>,
  repo: GithubRepo,
  githubRegistrationToken: string,
  label: string,
): Promise<string> {
  core.startGroup('Create VM');

  const op = await instanceService.create(
    CreateInstanceRequest.fromPartial({
      folderId: config.input.folderId,
      description: `Runner for: ${repo.owner}/${repo.repo}`,
      zoneId: config.input.zoneId,
      platformId: config.input.platformId,
      resourcesSpec: config.input.resourcesSpec,
      metadata: {
        'user-data': buildUserDataScript(githubRegistrationToken, label).join('\n'),
      },
      labels: {},

      bootDiskSpec: {
        mode: AttachedDiskSpec_Mode.READ_WRITE,
        autoDelete: true,
        diskSpec: {
          typeId: config.input.diskType,
          size: config.input.diskSize,
          imageId: config.input.imageId,
        },
      },
      networkInterfaceSpecs: [
        {
          subnetId: config.input.subnetId,
          primaryV4AddressSpec: {
            oneToOneNatSpec: {
              ipVersion: IpVersion.IPV4,
            },
          },
        },
      ],
      serviceAccountId: config.input.serviceAccountId,
    }),
  );
  const finishedOp = await waitForOperation(op, session);
  if (finishedOp.metadata) {
    const instanceId = decodeMessage<CreateInstanceMetadata>(finishedOp.metadata).instanceId;
    core.info(`Created instance with id '${instanceId}'`);
    core.endGroup();
    return instanceId;
  } else {
    core.error(`Failed to create instance'`);
    core.endGroup();
    throw new Error('Failed to create instance');
  }
}

async function destroyVm(
  session: Session,
  instanceService: WrappedServiceClientType<typeof InstanceServiceService>,
): Promise<void> {
  core.startGroup('Create VM');

  const op = await instanceService.delete(
    DeleteInstanceRequest.fromPartial({
      instanceId: config.input.instanceId,
    }),
  );
  const finishedOp = await waitForOperation(op, session);
  if (finishedOp.metadata) {
    const instanceId = decodeMessage<CreateInstanceMetadata>(finishedOp.metadata).instanceId;
    core.info(`Destroyed instance with id '${instanceId}'`);
    core.setOutput('instance-id', instanceId);
  } else {
    core.error(`Failed to create instance'`);
    throw new Error('Failed to create instance');
  }
  core.endGroup();
}

async function start(
  session: Session,
  instanceService: WrappedServiceClientType<typeof InstanceServiceService>,
): Promise<void> {
  const label = config.generateUniqueLabel();
  const githubRegistrationToken = await getRegistrationToken(config);
  const instanceId = await createVm(session, instanceService, github.context.repo, githubRegistrationToken, label);
  core.setOutput('label', label);
  core.setOutput('instance-id', instanceId);
  await waitForRunnerRegistered(config, label);
}

async function stop(
  session: Session,
  instanceService: WrappedServiceClientType<typeof InstanceServiceService>,
): Promise<void> {
  await destroyVm(session, instanceService);
  await removeRunner(config);
}

async function run(): Promise<void> {
  try {
    core.info(`start`);
    const ycSaJsonCredentials = core.getInput('yc-sa-json-credentials', {
      required: true,
    });

    core.info(`Folder ID: ${config.input.folderId}`);

    const serviceAccountJson = fromServiceAccountJsonFile(JSON.parse(ycSaJsonCredentials));
    core.info('Parsed Service account JSON');

    const session = new Session({serviceAccountJson});
    const instanceService = session.client(serviceClients.InstanceServiceClient);

    switch (config.input.mode) {
      case 'start': {
        await start(session, instanceService);
        break;
      }
      case 'stop': {
        await stop(session, instanceService);
        break;
      }
      default:
        // noinspection ExceptionCaughtLocallyJS
        throw new Error(`Unknown mode ${config.input.mode}`);
    }
  } catch (error) {
    core.setFailed(error as Error);
  }
}

run();
