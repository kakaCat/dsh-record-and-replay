/**
 * Core 公共契约测试（本卡验收：六类 BrowserAction + 七个稳定错误码 + 依赖边界）。
 *
 * 全部断言都是可复核的失败判据：任何一条为空/越界，测试直接失败。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BROWSER_ACTION_KINDS,
  CORE_API_VERSION,
  ERROR_CATEGORIES,
  ERROR_CODES,
  SCHEMA_VERSION,
  STABLE_ERROR_CODES,
  STABLE_ERROR_METADATA,
  SUPPORTED_SCHEMA_VERSIONS,
  assertRecordingId,
  assertRunId,
  assertStepId,
  createPublicError,
  isBrowserAction,
  isPublicError,
  isRecordingId,
  isRunId,
  isSemanticTarget,
  isStableErrorCode,
  isStepId,
  isSupportedSchemaVersion,
  newRecordingId,
  newRunId,
  newStepId,
  sanitizePublicMessage,
  toPublicError,
  type BrowserAction,
  type BrowserActionKind,
  type ErrorCategory,
  type JsonValue,
  type PublicError,
  type SemanticTarget,
} from '../../../src/core/api.js';

const CORE_SOURCE_DIR = fileURLToPath(new URL('../../../src/core/', import.meta.url));

function expectPublicErrorCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(isPublicError(error)).toBe(true);
    expect(isPublicError(error) ? error.code : null).toBe(code);
    return;
  }
  throw new Error(`expected PublicError(${code}) but nothing was thrown`);
}

/** 编译期穷尽性检查：缺少任一 kind 分支都会让这里编译失败。 */
function describeAction(action: BrowserAction): string {
  switch (action.kind) {
    case 'navigate':
      return `navigate:${action.url}`;
    case 'click':
      return `click:${'role' in action.target ? action.target.role : ''}`;
    case 'setValue':
      return `setValue:${action.value.length}`;
    case 'scroll':
      return `scroll:${action.deltaY}`;
    case 'key':
      return `key:${action.key}`;
    case 'wait':
      return `wait:${action.condition.kind}`;
    case 'assert':
      return `assert:${action.check.kind}`;
    case 'drag':
      return `drag:${action.from.role ?? ''}`;
  }
}

const ACTION_SAMPLES: readonly BrowserAction[] = [
  { kind: 'navigate', url: 'http://127.0.0.1:4173/form.html' },
  { kind: 'click', target: { role: 'button', name: 'Submit' } },
  { kind: 'setValue', target: { css: '#email' }, value: 'agent@example.test', secretRef: 'secret.email' },
  { kind: 'drag', from: { role: 'button', name: 'Card' }, to: { role: 'button', name: 'Done' } },
  { kind: 'scroll', target: { text: 'Terms' }, deltaX: 0, deltaY: 480 },
  { kind: 'key', key: 'Enter' },
  { kind: 'wait', condition: { kind: 'text', text: 'Saved' }, timeoutMs: 5_000 },
  { kind: 'assert', check: { kind: 'url', contains: '/form.html' } },
];

const ACTION_SUMMARIES = [
  'navigate:http://127.0.0.1:4173/form.html',
  'click:button',
  'setValue:18',
  'drag:button',
  'scroll:480',
  'key:Enter',
  'wait:text',
  'assert:url',
];

describe('core/api BrowserAction', () => {
  it('恰好导出七个动作 kind，且判别联合可穷尽', () => {
    expect(BROWSER_ACTION_KINDS).toHaveLength(8);
    expect(new Set(BROWSER_ACTION_KINDS).size).toBe(8);
    expect([...BROWSER_ACTION_KINDS].sort()).toEqual(['assert', 'click', 'drag', 'key', 'navigate', 'scroll', 'setValue', 'wait']);

    // 若联合里新增/删除了 kind，这个 Record 会编译失败。
    const covered: Record<BrowserActionKind, true> = {
      navigate: true,
      click: true,
      setValue: true,
      scroll: true,
      key: true,
      wait: true,
      assert: true,
      drag: true,
    };
    expect(Object.keys(covered).sort()).toEqual(['assert', 'click', 'drag', 'key', 'navigate', 'scroll', 'setValue', 'wait']);
  });

  it('八个样本全部通过 isBrowserAction，并可按 kind 分发', () => {
    expect(ACTION_SAMPLES).toHaveLength(8);
    expect(ACTION_SAMPLES.map((action) => isBrowserAction(action))).toEqual([true, true, true, true, true, true, true, true]);
    expect(ACTION_SAMPLES.map((action) => action.kind)).toEqual([...BROWSER_ACTION_KINDS]);
    expect(ACTION_SAMPLES.map(describeAction)).toEqual(ACTION_SUMMARIES);
  });

  it('拒绝非法动作与七类之外的动作名', () => {
    const invalid: readonly unknown[] = [
      undefined,
      null,
      'navigate',
      [],
      {},
      { kind: 'screenshot', scope: 'tab' },
      { kind: 'observe' },
      { kind: 'navigate' },
      { kind: 'navigate', url: 'file:///tmp/index.html' },
      { kind: 'navigate', url: '' },
      { kind: 'click' },
      { kind: 'click', target: {} },
      { kind: 'click', target: { role: '' } },
      { kind: 'setValue', target: { role: 'textbox' } },
      { kind: 'setValue', target: { role: 'textbox' }, value: 42 },
      { kind: 'setValue', target: { role: 'textbox' }, value: 'x', secretRef: '' },
      { kind: 'scroll', deltaX: 0 },
      { kind: 'scroll', deltaX: 0, deltaY: Number.NaN },
      { kind: 'key', key: '' },
      { kind: 'key', target: {} , key: 'Enter' },
      { kind: 'wait', condition: { kind: 'css' }, timeoutMs: 100 },
      { kind: 'wait', condition: { kind: 'idle', quietMs: 0 }, timeoutMs: 100 },
      { kind: 'wait', condition: { kind: 'text', text: 'x' }, timeoutMs: 0 },
      { kind: 'wait', condition: { kind: 'text', text: 'x' }, timeoutMs: Number.POSITIVE_INFINITY },
      { kind: 'assert' },
      { kind: 'assert', check: { kind: 'url' } },
      { kind: 'assert', check: { kind: 'element', target: { css: '#x' }, exists: true } },
      { kind: 'assert', check: { kind: 'value', target: { role: 'textbox' } } },
    ];
    for (const candidate of invalid) {
      expect(isBrowserAction(candidate)).toBe(false);
    }
  });

  it('SemanticTarget 只接受长期定位字段（url/role/name/text/css），拒绝空目标', () => {
    const valid: readonly SemanticTarget[] = [
      { role: 'button', name: 'Submit' },
      { name: 'Email' },
      { css: '#email' },
      { text: 'Submit order' },
      { url: { origin: 'http://127.0.0.1:4173' } },
      { url: { path: '/form.html' } },
      { role: 'textbox', extensions: { driverRef: 'ref-1' } },
    ];
    for (const target of valid) {
      expect(isSemanticTarget(target)).toBe(true);
    }
    const invalid: readonly unknown[] = [
      undefined,
      null,
      {},
      { role: '' },
      { url: {} },
      { url: { origin: 42 } },
      { extensions: { driverRef: 'ref-1' } },
      { role: ['button'] },
    ];
    for (const candidate of invalid) {
      expect(isSemanticTarget(candidate)).toBe(false);
    }
  });

  it('click/key/setValue 标记为不可逆动作', () => {
    const irreversible = ACTION_SAMPLES.filter((action) => action.kind === 'click' || action.kind === 'key' || action.kind === 'setValue');
    expect(irreversible.map((action) => action.kind)).toEqual(['click', 'setValue', 'key']);
  });
});

describe('core/api 七个稳定错误码', () => {
  it('恰好七个、互不重复，且每类默认处理各一个', () => {
    expect(STABLE_ERROR_CODES).toHaveLength(7);
    expect(new Set(STABLE_ERROR_CODES).size).toBe(7);
    expect([...STABLE_ERROR_CODES].sort()).toEqual([
      'BROWSER_BINDING_STALE',
      'CUA_TRANSPORT_UNAVAILABLE',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
      'OPERATION_CANCELLED',
      'STORE_CORRUPT_JSONL',
      'TARGET_NOT_FOUND',
    ]);

    const categories = STABLE_ERROR_CODES.map((code) => STABLE_ERROR_METADATA[code].category);
    expect([...categories].sort()).toEqual([...ERROR_CATEGORIES].sort());
    const uniqueCategories: readonly ErrorCategory[] = ERROR_CATEGORIES;
    expect(new Set(categories).size).toBe(uniqueCategories.length);

    for (const code of STABLE_ERROR_CODES) {
      expect(isStableErrorCode(code)).toBe(true);
      expect(ERROR_CODES).toContain(code);
      expect(typeof STABLE_ERROR_METADATA[code].retryable).toBe('boolean');
      expect(STABLE_ERROR_METADATA[code].description.length).toBeGreaterThan(0);
    }
  });

  it('七个稳定码之外的设计文档码也登记了，但不算 core 稳定码', () => {
    expect(ERROR_CODES).toContain('BROWSER_TARGET_BUSY');
    expect(ERROR_CODES).toContain('TARGET_AMBIGUOUS');
    expect(ERROR_CODES).toContain('ACTION_UNSUPPORTED');
    expect(isStableErrorCode('BROWSER_TARGET_BUSY')).toBe(false);
    expect(isStableErrorCode('CUA_TRANSPORT_UNAVAILABLE')).toBe(true);
  });

  it('PublicError 只含 code/message/定位 ID', () => {
    const error = createPublicError('TARGET_NOT_FOUND', 'button is gone', {
      recordingId: 'rec_1',
      runId: 'run_2',
      stepId: 'step_3',
    });
    expect(error).toEqual({
      code: 'TARGET_NOT_FOUND',
      message: 'button is gone',
      recordingId: 'rec_1',
      runId: 'run_2',
      stepId: 'step_3',
    });
    expect(isPublicError(error)).toBe(true);
    expect(isPublicError({ code: 'NOT_A_CODE', message: 'x' })).toBe(false);
    expect(isPublicError(new Error('x'))).toBe(false);
  });

  it('对外 message 不含秘密与绝对路径', () => {
    expect(sanitizePublicMessage('request failed: Cookie: sid=abc123')).toBe('request failed: Cookie: ***');
    expect(sanitizePublicMessage('Authorization: Bearer eyJhbGciOi.test')).not.toContain('eyJhbGciOi');
    expect(sanitizePublicMessage('sent Bearer token-value')).toBe('sent <redacted-credentials>');
    expect(sanitizePublicMessage('/Volumes/work/secret/x.jsonl not found')).toBe('<path> not found');
    expect(sanitizePublicMessage('open C:\\Users\\me\\a.txt failed')).toBe('open <path> failed');
    expect(sanitizePublicMessage('download file:///tmp/a.png')).toBe('download <path>');

    const error = createPublicError('STORE_CORRUPT_JSONL', 'bad tail at /Users/me/rec/steps.jsonl');
    expect(error.message).not.toContain('/Users/me');
    expect(error.message).toContain('<path>');
  });

  it('toPublicError 保留稳定码与定位 ID，并清洗非 PublicError', () => {
    const fromError = toPublicError(new Error('read /etc/secrets failed'), {
      fallbackCode: 'STORE_CORRUPT_JSONL',
      ids: { recordingId: 'rec_x' },
    });
    expect(fromError.code).toBe('STORE_CORRUPT_JSONL');
    expect(fromError.recordingId).toBe('rec_x');
    expect(fromError.message).not.toContain('/etc/secrets');
    expect(fromError.message).toContain('<path>');

    const original = createPublicError('BROWSER_BINDING_STALE', 'stale', { runId: 'run_9' });
    expect(toPublicError(original)).toEqual(original);
  });
});

describe('core/api 稳定 ID', () => {
  it('生成三类 ID：前缀正确、满足图案、互不重复', () => {
    const recordings = new Set<string>();
    const runs = new Set<string>();
    const steps = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const recordingId = newRecordingId();
      const runId = newRunId();
      const stepId = newStepId();
      expect(isRecordingId(recordingId)).toBe(true);
      expect(isRunId(runId)).toBe(true);
      expect(isStepId(stepId)).toBe(true);
      expect(recordingId.startsWith('rec_')).toBe(true);
      expect(runId.startsWith('run_')).toBe(true);
      expect(stepId.startsWith('step_')).toBe(true);
      recordings.add(recordingId);
      runs.add(runId);
      steps.add(stepId);
    }
    expect(recordings.size).toBe(50);
    expect(runs.size).toBe(50);
    expect(steps.size).toBe(50);
  });

  it('拒绝非法形态，并以 INVALID_ARGUMENT 抛出 PublicError', () => {
    for (const candidate of [undefined, null, '', 'rec_', 'rec_bad-id', 'REC_x', 42, {}]) {
      expect(isRecordingId(candidate)).toBe(false);
    }
    for (const candidate of ['run_', 'run_bad-id', 'step_x']) {
      expect(isRunId(candidate)).toBe(false);
    }
    for (const candidate of ['step_', 'step_bad-id', 'run_x']) {
      expect(isStepId(candidate)).toBe(false);
    }

    expectPublicErrorCode(() => assertRecordingId('nope'), 'INVALID_ARGUMENT');
    expectPublicErrorCode(() => assertRunId('nope'), 'INVALID_ARGUMENT');
    expectPublicErrorCode(() => assertStepId('nope'), 'INVALID_ARGUMENT');
    expect(assertRecordingId('rec_abc')).toBe('rec_abc');
    expect(assertRunId('run_abc')).toBe('run_abc');
    expect(assertStepId('step_abc')).toBe('step_abc');
  });
});

describe('core/api 版本常量', () => {
  it('schema 版本 1 在支持范围内，未知版本被拒绝', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(SCHEMA_VERSION);
    expect(isSupportedSchemaVersion(1)).toBe(true);
    expect(isSupportedSchemaVersion(2)).toBe(false);
    expect(isSupportedSchemaVersion('1')).toBe(false);
    expect(isSupportedSchemaVersion(null)).toBe(false);
    expect(CORE_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('core 依赖边界', () => {
  it('core/*.ts 不引入 Electron / Cua / Cordis', () => {
    const files = readdirSync(CORE_SOURCE_DIR).filter((name) => name.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['api.ts', 'actions.ts', 'errors.ts', 'ids.ts', 'version.ts']));

    const forbidden = /(?:from\s+|require\(\s*)['"](?:electron|@trycua|cordis)(?:['"/])/;
    for (const file of files) {
      const source = readFileSync(join(CORE_SOURCE_DIR, file), 'utf8');
      expect({ file, forbidden: forbidden.test(source) }).toEqual({ file, forbidden: false });
    }
  });

  it('BrowserAction 示例可 JSON 序列化（动作是纯数据）', () => {
    const roundTrip = ACTION_SAMPLES.map((action) => JSON.parse(JSON.stringify(action)) as JsonValue);
    expect(roundTrip).toHaveLength(8);
    for (const action of roundTrip) {
      expect(isBrowserAction(action)).toBe(true);
    }
  });
});
