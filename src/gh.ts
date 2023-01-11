import * as core from '@actions/core';
import * as github from '@actions/github';
import {Config} from './config';

interface Runner {
  /** The id of the runner. */
  id: number;
  /** The name of the runner. */
  name: string;
  /** The Operating System of the runner. */
  os: string;
  /** The status of the runner. */
  status: string;
  busy: boolean;
  labels: {
    /** Unique identifier of the label. */
    id?: number;
    /** Name of the label. */
    name?: string;
    /** The type of label. Read-only labels are applied automatically when the runner is configured. */
    type?: 'read-only' | 'custom';
  }[];
}

// use the unique label to find the runner
// as we don't have the runner's id, it's not possible to get it in any other way
export async function getRunner(config: Config, label: string): Promise<Runner | null> {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    const runners = (await octokit.paginate(
      'GET /repos/{owner}/{repo}/actions/runners',
      config.githubContext,
    )) as Runner[];
    const foundRunners = runners.filter(x => x.labels.some(l => l.name === label));
    return foundRunners.length > 0 ? foundRunners[0] : null;
  } catch (error) {
    return null;
  }
}

// get GitHub Registration Token for registering a self-hosted runner
export async function getRegistrationToken(config: Config): Promise<string> {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    const req = {
      ...config.githubContext,
    };
    const response = await octokit.request('POST /repos/{owner}/{repo}/actions/runners/registration-token', req);
    core.info('GitHub Registration Token is received');
    return response.data.token;
  } catch (error) {
    core.error('GitHub Registration Token receiving error');
    throw error;
  }
}

export async function removeRunner(config: Config): Promise<void> {
  const runner = await getRunner(config, config.input.label);
  const octokit = github.getOctokit(config.input.githubToken);

  // skip the runner removal process if the runner is not found
  if (!runner) {
    core.info(`GitHub self-hosted runner with label ${config.input.label} is not found, so the removal is skipped`);
    return;
  }

  try {
    const req = {
      ...config.githubContext,
      runner_id: runner.id,
    };
    await octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', req);
    core.info(`GitHub self-hosted runner ${runner.name} is removed`);
    return;
  } catch (error) {
    core.error('GitHub self-hosted runner removal error');
    throw error;
  }
}

export async function waitForRunnerRegistered(config: Config, label: string): Promise<void> {
  const timeoutMinutes = 5;
  const retryIntervalSeconds = 10;
  const quietPeriodSeconds = 30;
  let waitSeconds = 0;

  core.info(`Waiting ${quietPeriodSeconds}s for the instance to be registered in GitHub as a new self-hosted runner`);
  await new Promise(r => setTimeout(r, quietPeriodSeconds * 1000));
  core.info(`Checking every ${retryIntervalSeconds}s if the GitHub self-hosted runner is registered`);

  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      const runner = await getRunner(config, label);

      if (waitSeconds > timeoutMinutes * 60) {
        core.error('GitHub self-hosted runner registration error');
        clearInterval(interval);

        reject(
          new Error(
            // eslint-disable-next-line max-len
            `A timeout of ${timeoutMinutes} minutes is exceeded. Your YC instance was not able to register itself in GitHub as a new self-hosted runner.`,
          ),
        );
      }

      if (runner && runner.status === 'online') {
        core.info(`GitHub self-hosted runner ${runner.name} is registered and ready to use`);
        clearInterval(interval);
        resolve();
      } else {
        waitSeconds += retryIntervalSeconds;
        core.info('Checking...');
      }
    }, retryIntervalSeconds * 1000);
  });
}
