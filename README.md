## GitHub Action to On-demand self-hosted YC runner for GitHub Actions.

Start your Yandex Cloud self-hosted runner right before you need it. Run the job on it. Finally, stop it when you
finish. And all this automatically as a part of your GitHub Actions workflow.

**Table of Contents**

<!-- toc -->

- [Usage](#usage)
- [Permissions](#permissions)
- [License Summary](#license-summary)

<!-- tocstop -->

## Usage

```yaml
name: do-the-job
on: pull_request
jobs:
  start-runner:
    name: Start self-hosted YC runner
    runs-on: ubuntu-latest
    outputs:
      label: ${{ steps.start-yc-runner.outputs.label }}
      instance-id: ${{ steps.start-yc-runner.outputs.yc-instance-id }}
    steps:
      - name: Start YC runner
        id: start-yc-runner
        uses: yc-actions/yc-github-runner@v1
        with:
          mode: start
          yc-sa-json-credentials: ${{ secrets.YC_SA_JSON_CREDENTIALS }}
          github-token: ${{ secrets.GH_PERSONAL_ACCESS_TOKEN }}
          folder-id: b1g*****
          image-id: fd80o2eikcn22b229tsa # COI image id
          service-account-id: ajeqnasj95o7******** # optional, if required additional permissions
          cores: 2
          memory: 512Mb
          core-fraction: 100
          subnet-id: e9b*********
  do-the-job:
    name: Do the job on the runner
    needs: start-runner # required to start the main job when the runner is ready
    runs-on: ${{ needs.start-runner.outputs.label }} # run the job on the newly created runner
    steps:
      - name: Hello World
        run: echo 'Hello World!'
  stop-runner:
    name: Stop self-hosted YC runner
    needs:
      - start-runner # required to get output from the start-runner job
      - do-the-job # required to wait when the main job is done
    runs-on: ubuntu-latest
    if: ${{ always() }} # required to stop the runner even if the error happened in the previous jobs
    steps:
      - name: Stop YC runner
        uses: yc-actions/yc-github-runner@v1
        with:
          mode: stop
          yc-sa-json-credentials: ${{ secrets.YC_SA_JSON_CREDENTIALS }}
          github-token: ${{ secrets.GH_PERSONAL_ACCESS_TOKEN }}
          label: ${{ needs.start-runner.outputs.label }}
          instance-id: ${{ needs.start-runner.outputs.yc-instance-id }}
```

See [action.yml](action.yml) for the full documentation for this action's inputs and outputs.

## Permissions

To perform this action, it is required that the service account on behalf of which we are acting has granted
the `compute.admin` role or greater.

## License Summary

This code is made available under the MIT license.
