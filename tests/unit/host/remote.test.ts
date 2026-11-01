import { describe, expect, it } from 'vitest'
import type { Principal } from '../../../src/core/api.js'
import type { HostConfig } from '../../../src/host/config.js'
import { OperationRunner } from '../../../src/driver/operation-runner.js'
import { CuaRecordReplayService, type RecordingReadPort, type ReplayPort } from '../../../src/host/service.js'
import {
  REMOTE_API_VERSION,
  createRemoteApi,
  type RemoteAuthenticator,
  type RemoteCredential,
} from '../../../src/host/remote.js'
import { FakeBrowserDriver } from './fake-driver.js'
import { FakeRecordingPort, FakeReplayPort, rec, recordingSummary, run } from './fake-ports.js'
import { RecordingSink, disabledConfig, enabledConfig, walkingClock } from './support.js'

const PRINCIPALS: Readonly<Record<string, Principal>> = {
  'token-a': { agentId: 'agent-a', sessionId: 'session-a' },
  'token-b': { agentId: 'agent-b', sessionId: 'session-b' },
}

const credential = (token: string): RemoteCredential => ({ token })

function authenticate(credentialValue: RemoteCredential | undefined): Principal | undefined {
  return credentialValue === undefined ? undefined : PRINCIPALS[credentialValue.token]
}

function setup(options: {
  readonly config?: HostConfig
  readonly recordings?: RecordingReadPort
  readonly replay?: ReplayPort
  readonly controls?: boolean
  readonly authenticator?: RemoteAuthenticator
} = {}): {
  readonly driver: FakeBrowserDriver
  readonly service: CuaRecordReplayService
  readonly remote: ReturnType<typeof createRemoteApi>
  readonly controls: { enabled: boolean }
} {
  const driver = new FakeBrowserDriver()
  const sink = new RecordingSink()
  const runner = new OperationRunner({ driver, events: sink, clock: walkingClock() })
  const service = new CuaRecordReplayService({
    config: options.config ?? enabledConfig(),
    driver,
    runner,
    ...(options.recordings === undefined ? {} : { recordings: options.recordings }),
    ...(options.replay === undefined ? {} : { replay: options.replay }),
  })
  const controls = { enabled: options.controls ?? false }
  const remote = createRemoteApi(service, {
    authenticate: options.authenticator ?? authenticate,
    controlsEnabled: () => controls.enabled,
  })
  return { driver, service, remote, controls }
}

describe('host/remote', () => {
  it('wraps public DTOs with the independent Remote apiVersion', async () => {
    const recordings = new FakeRecordingPort()
    recordings.recordings = [recordingSummary(rec('a'), 'session-a')]
    const { remote } = setup({ recordings })

    const response = await remote.listRecordings({}, credential('token-a'))
    expect(response.apiVersion).toBe(REMOTE_API_VERSION)
    expect(response.data.items.map(item => item.recordingId)).toEqual([rec('a')])
  })

  it('rejects unauthenticated and throwing authenticators with REMOTE_UNAUTHORIZED', async () => {
    const { remote } = setup()
    await expect(remote.listRecordings({}, undefined)).rejects.toMatchObject({ code: 'REMOTE_UNAUTHORIZED' })
    await expect(remote.listRecordings({}, credential('unknown-token')))
      .rejects.toMatchObject({ code: 'REMOTE_UNAUTHORIZED' })

    const throwing = setup({ authenticator: () => { throw new Error('auth backend down at /Volumes/secret') } })
    await expect(throwing.remote.listRecordings({}, credential('token-a')))
      .rejects.toMatchObject({ code: 'REMOTE_UNAUTHORIZED' })
  })

  it('never lets a query select another ownerSessionId', async () => {
    const { remote } = setup()
    await expect(remote.listRecordings({ ownerSessionId: 'session-b' } as never, credential('token-a')))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(remote.listRuns({ sessionId: 'session-b' } as never, credential('token-a')))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('filters read models to the authenticated session and answers null for foreign records', async () => {
    const recordings = new FakeRecordingPort()
    recordings.recordings = [
      recordingSummary(rec('a'), 'session-a'),
      recordingSummary(rec('b'), 'session-b'),
    ]
    const { remote } = setup({ recordings })

    const page = await remote.listRecordings({}, credential('token-a'))
    expect(page.data.items.map(item => item.recordingId)).toEqual([rec('a')])

    expect((await remote.getRecording(rec('b'), credential('token-a'))).data).toBeNull()
    expect((await remote.getRecording(rec('a'), credential('token-a'))).data)
      .toMatchObject({ recordingId: rec('a') })
  })

  it('keeps control commands behind the operator switch', async () => {
    const replay = new FakeReplayPort()
    replay.runs = [{ runId: run('1'), recordingId: rec('a'), status: 'running', ownerSessionId: 'session-a' }]
    const { remote, controls } = setup({ replay, controls: false })

    await expect(remote.cancelRun({ runId: run('1'), ownerSessionId: 'session-a' }, credential('token-a')))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })

    controls.enabled = true
    await expect(remote.cancelRun({ runId: run('1'), ownerSessionId: 'session-b' }, credential('token-a')))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })

    const cancelled = await remote.cancelRun({ runId: run('1'), ownerSessionId: 'session-a' }, credential('token-a'))
    expect(cancelled.data.status).toBe('cancelled')

    const started = await remote.startReplay({ recordingId: rec('a'), ownerSessionId: 'session-a' }, credential('token-a'))
    expect(started.data.runId).toBe(run('started'))
    expect(replay.startCalls).toHaveLength(1)
  })

  it('reports a disabled replay feature even when controls are enabled', async () => {
    const replay = new FakeReplayPort()
    const { remote, controls } = setup({ replay, controls: true, config: disabledConfig() })
    await expect(remote.startReplay({ recordingId: rec('a'), ownerSessionId: 'session-a' }, credential('token-a')))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
  })

  it('sanitizes internal errors before they reach the UI', async () => {
    class BrokenRecordingPort extends FakeRecordingPort {
      override async listRecordings(): Promise<never> {
        throw new Error('store failed at /Volumes/work/recordings/rec_a/steps.jsonl')
      }
    }
    const { remote } = setup({ recordings: new BrokenRecordingPort() })

    try {
      await remote.listRecordings({}, credential('token-a'))
      throw new Error('expected the remote call to reject')
    } catch (error) {
      const publicError = error as { code?: string; message?: string }
      expect(publicError.code).toBe('INVALID_ARGUMENT')
      expect(publicError.message).toContain('<path>')
      expect(publicError.message).not.toContain('Volumes')
    }
  })

  it('performs no browser action for any query', async () => {
    const recordings = new FakeRecordingPort()
    recordings.recordings = [recordingSummary(rec('a'), 'session-a')]
    const replay = new FakeReplayPort()
    replay.runs = [{ runId: run('1'), recordingId: rec('a'), status: 'completed', ownerSessionId: 'session-a' }]
    const { driver, remote } = setup({ recordings, replay })

    await remote.listRecordings({}, credential('token-a'))
    await remote.getRecording(rec('a'), credential('token-a'))
    await remote.listSteps(rec('a'), {}, credential('token-a'))
    await remote.listRuns({}, credential('token-a'))
    await remote.getRun(run('1'), credential('token-a'))

    expect(driver.bindCalls).toBe(0)
    expect(driver.observeCalls).toBe(0)
    expect(driver.executeCalls).toHaveLength(0)
  })
})
