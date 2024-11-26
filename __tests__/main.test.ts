import { describe, expect, test } from '@jest/globals'
import * as cp from 'child_process'
import * as path from 'path'
import * as process from 'process'
import { buildUserDataScript } from '../src/main'

// This test will run only in fully configured env and creates real VM
// in the Yandex Cloud, so it will be disabled in CI/CD. You can enable it to test locally.
test.skip('runs', () => {
    process.env['GITHUB_WORKSPACE'] = ''

    const np = process.execPath
    const ip = path.join(__dirname, '..', 'lib', 'main.js')
    const options: cp.ExecFileSyncOptions = {
        env: process.env
    }
    let res
    try {
        res = cp.execFileSync(np, [ip], options)
    } catch (e) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.log((e as any).stdout.toString())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.log((e as any).stderr.toString())
    }
    console.log(res?.toString())
})

describe('cloud-init', () => {
    test('default', () => {
        const actual = buildUserDataScript({
            githubRegistrationToken: 'githubRegistrationToken',
            label: 'label',
            owner: 'owner',
            repo: 'repo',
            runnerHomeDir: '',
            user: '',
            sshPublicKey: '',
            runnerVersion: '2.299.1',
            disableUpdate: false
        })
        expect(actual.length).toBe(8)
        expect(actual).toMatchSnapshot()
        expect(actual[0]).toBe('#!/bin/bash')
    })

    test('with home dir', () => {
        const actual = buildUserDataScript({
            githubRegistrationToken: 'githubRegistrationToken',
            label: 'label',
            owner: 'owner',
            repo: 'repo',
            runnerHomeDir: 'foo',
            user: '',
            sshPublicKey: '',
            runnerVersion: '2.299.1',
            disableUpdate: false
        })
        expect(actual.length).toBe(5)
        expect(actual).toMatchSnapshot()
        expect(actual[0]).toBe('#!/bin/bash')
    })

    test('with user and ssh key', () => {
        const actual = buildUserDataScript({
            githubRegistrationToken: 'githubRegistrationToken',
            label: 'label',
            owner: 'owner',
            repo: 'repo',
            runnerHomeDir: '',
            user: 'user',
            sshPublicKey: 'key',
            runnerVersion: '2.299.1',
            disableUpdate: false
        })
        expect(actual.length).toBe(23)
        expect(actual).toMatchSnapshot()
        expect(actual[0]).toBe('#cloud-config')
    })

    test('with home dir and user and ssh key', () => {
        const actual = buildUserDataScript({
            githubRegistrationToken: 'githubRegistrationToken',
            label: 'label',
            owner: 'owner',
            repo: 'repo',
            runnerHomeDir: 'foo',
            user: 'user',
            sshPublicKey: 'key',
            runnerVersion: '2.299.1',
            disableUpdate: false
        })
        expect(actual.length).toBe(16)
        expect(actual).toMatchSnapshot()
        expect(actual[0]).toBe('#cloud-config')
    })

    test('with disable update', () => {
        const actual = buildUserDataScript({
            githubRegistrationToken: 'githubRegistrationToken',
            label: 'label',
            owner: 'owner',
            repo: 'repo',
            runnerHomeDir: '',
            user: '',
            sshPublicKey: '',
            runnerVersion: '2.299.1',
            disableUpdate: true
        })
        expect(actual.length).toBe(8)
        expect(actual).toMatchSnapshot()
        expect(actual[6]).toContain('--disableupdate')
    })

    test('without disable update', () => {
        const actual = buildUserDataScript({
            githubRegistrationToken: 'githubRegistrationToken',
            label: 'label',
            owner: 'owner',
            repo: 'repo',
            runnerHomeDir: '',
            user: '',
            sshPublicKey: '',
            runnerVersion: '2.299.1',
            disableUpdate: false
        })
        expect(actual.length).toBe(8)
        expect(actual).toMatchSnapshot()
        expect(actual[6]).not.toContain('--disableupdate')
    })
})
