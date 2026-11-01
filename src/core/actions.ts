/**
 * 浏览器语义动作（BrowserAction）与长期定位目标（SemanticTarget）。
 *
 * 契约要点（design/interfaces.md IF-2、design/data-model.md、需求 FR-1）：
 * - 六类动作：navigate / click / setValue / scroll / key / wait；
 *   `screenshot` 属于「证据/观察」，不进 BrowserAction（本卡验收要求六类动作）。
 * - SemanticTarget 只保留长期定位信息（url/role/name/text/css），**不含** ref、句柄、token；
 *   运行期 ref 由 Driver 在 Observation/ResolvedTarget 里维护，不进公共动作模型。
 * - 动作是纯数据：可 JSON 序列化、可持久化（value 落盘前由 Redactor 处理）。
 * - 本文件不依赖 Electron / Cua / Cordis，只依赖 Core 自身的 JSON 类型。
 */

import type { JsonValue } from './api.js';
import {
  ACTION_KINDS,
  TARGET_FIELDS,
  TARGET_URL_FIELDS,
  isNavigableUrl,
  type ActionKind,
  type TargetField,
} from './contracts.js';

export { isNavigableUrl };

/**
 * 语义动作：六类操作 + assert（结果校验）。
 *
 * 取值来自 `contracts.ts` 的 `ACTION_SPECS` 单一来源；此处只保留历史 API 名称。
 */
export type BrowserActionKind = ActionKind;

/** 长期定位提示；调用方至少给一个定位字段，Driver 负责唯一性/可见性校验。 */
export interface SemanticTargetUrl {
  /** 期望的 origin，如 `http://127.0.0.1:4173`。 */
  readonly origin?: string;
  /** 期望的 path，如 `/form.html`。 */
  readonly path?: string;
}

export interface SemanticTarget {
  readonly url?: SemanticTargetUrl;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly css?: string;
  /** 0-based 序号：同名目标有多个时按出现顺序取第 N 个。 */
  readonly index?: number;
  /** Driver 扩展的额外定位信息（不得放 Secret 或运行期句柄）。 */
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

type AssertTrue<T extends true> = T;

/**
 * 编译期守卫：`SemanticTarget` 的键必须与 `contracts.ts` 的
 * `TARGET_FIELD_SCHEMAS` 完全一致。任一侧新增字段而另一侧没跟上都会在这里报错。
 */
type SemanticTargetFieldsMatch = AssertTrue<
  [TargetField] extends [keyof SemanticTarget]
    ? [keyof SemanticTarget] extends [TargetField]
      ? true
      : false
    : false
>;

/** wait 的等待条件；具体实现由 Driver 映射到 Cua 的 wait_for/expect 等能力。 */
export type WaitCondition =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'css'; readonly css: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'idle'; readonly quietMs: number };

export type NavigateAction = { readonly kind: 'navigate'; readonly url: string };

export type ClickAction = {
  readonly kind: 'click';
  readonly target: SemanticTarget;
  /** 鼠标键；缺省 left。桌面绑定支持 right。 */
  readonly button?: 'left' | 'right';
  /** 点击次数；缺省 1（2 = 双击）。 */
  readonly count?: number;
};

export type SetValueAction = {
  readonly kind: 'setValue';
  readonly target: SemanticTarget;
  /** 明文只存在于进程内；持久化前必须被 Redactor 替换为掩码或 secretRef。 */
  readonly value: string;
  /** 可选：引用外部 SecretResolver 的槽位，落盘时保存引用而不是值。 */
  readonly secretRef?: string;
};

export type DragAction = {
  readonly kind: 'drag';
  readonly from: SemanticTarget;
  readonly to: SemanticTarget;
};

export type ScrollAction = {
  readonly kind: 'scroll';
  readonly target?: SemanticTarget;
  readonly deltaX: number;
  readonly deltaY: number;
};

export type KeyAction = {
  readonly kind: 'key';
  readonly target?: SemanticTarget;
  readonly key: string;
};

export type WaitAction = {
  readonly kind: 'wait';
  readonly condition: WaitCondition;
  readonly timeoutMs: number;
};

/** assert 的检查项：只做只读校验，不产生副作用。 */
export type AssertCheck =
  | { readonly kind: 'url'; readonly contains: string }
  | { readonly kind: 'text'; readonly contains: string }
  | { readonly kind: 'element'; readonly target: SemanticTarget; readonly exists: boolean }
  | { readonly kind: 'value'; readonly target: SemanticTarget; readonly equals: string };

export type AssertAction = {
  readonly kind: 'assert';
  readonly check: AssertCheck;
};

/** 判别联合：`kind` 是唯一判别子。 */
export type BrowserAction =
  | NavigateAction
  | ClickAction
  | SetValueAction
  | ScrollAction
  | KeyAction
  | WaitAction
  | AssertAction
  | DragAction;

/** 动作的运行时清单（顺序即文档顺序；单一来源见 `contracts.ts` 的 `ACTION_SPECS`）。 */
export const BROWSER_ACTION_KINDS = ACTION_KINDS;

/** 设计文档把 click/key/setValue 视为不可逆动作：结果未知时不得自动重发。 */
export const IRREVERSIBLE_ACTION_KINDS = ['click', 'setValue', 'key'] as const;

export function isBrowserActionKind(value: unknown): value is BrowserActionKind {
  return typeof value === 'string' && (BROWSER_ACTION_KINDS as readonly string[]).includes(value);
}

/** 浏览器动作结果未知时不得自动重发的动作。 */
export function isIrreversibleAction(action: BrowserAction): boolean {
  return (IRREVERSIBLE_ACTION_KINDS as readonly string[]).includes(action.kind);
}

export function isSemanticTarget(value: unknown): value is SemanticTarget {
  if (!isRecord(value)) {
    return false;
  }

  let hasLocator = false;
  for (const field of TARGET_FIELDS) {
    const candidate = value[field];
    if (candidate === undefined) {
      continue;
    }
    switch (field) {
      case 'url':
        if (!isSemanticTargetUrl(candidate)) {
          return false;
        }
        hasLocator = true;
        break;
      case 'role':
      case 'name':
      case 'text':
      case 'css':
        if (!isNonEmptyString(candidate)) {
          return false;
        }
        hasLocator = true;
        break;
      case 'index':
        if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
          return false;
        }
        break;
      case 'extensions':
        if (!isRecord(candidate)) {
          return false;
        }
        break;
      default: {
        // Compile-time exhaustiveness: a new field in TARGET_FIELD_SCHEMAS must
        // be handled here before TypeScript accepts the switch.
        const exhaustive: never = field;
        return exhaustive;
      }
    }
  }

  return hasLocator;
}

export function isWaitCondition(value: unknown): value is WaitCondition {
  if (!isRecord(value)) {
    return false;
  }
  switch (value['kind']) {
    case 'text':
      return isNonEmptyString(value['text']);
    case 'css':
      return isNonEmptyString(value['css']);
    case 'url':
      return isNonEmptyString(value['url']);
    case 'idle':
      return isPositiveFiniteNumber(value['quietMs']);
    default:
      return false;
  }
}

/** 运行时守卫：判断任意读入值是否是 BrowserAction 之一。 */
export function isBrowserAction(value: unknown): value is BrowserAction {
  if (!isRecord(value)) {
    return false;
  }
  switch (value['kind']) {
    case 'navigate':
      return isNavigableUrl(value['url']);
    case 'click':
      return isSemanticTarget(value['target'])
        && (value['button'] === undefined || value['button'] === 'left' || value['button'] === 'right')
        && (value['count'] === undefined || (Number.isInteger(value['count']) && (value['count'] as number) >= 1 && (value['count'] as number) <= 3));
    case 'setValue':
      return (
        isSemanticTarget(value['target']) &&
        typeof value['value'] === 'string' &&
        (value['secretRef'] === undefined || isNonEmptyString(value['secretRef']))
      );
    case 'scroll':
      return (
        (value['target'] === undefined || isSemanticTarget(value['target'])) &&
        isFiniteNumber(value['deltaX']) &&
        isFiniteNumber(value['deltaY'])
      );
    case 'key':
      return (
        (value['target'] === undefined || isSemanticTarget(value['target'])) && isNonEmptyString(value['key'])
      );
    case 'wait':
      return isWaitCondition(value['condition']) && isPositiveFiniteNumber(value['timeoutMs']);
    case 'assert':
      return isAssertCheck(value['check']);
    case 'drag':
      return isSemanticTarget(value['from']) && isSemanticTarget(value['to']);
    default:
      return false;
  }
}

export function isAssertCheck(value: unknown): value is AssertCheck {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'url':
    case 'text':
      return isNonEmptyString(value['contains']);
    case 'element':
      return isAssertTarget(value['target']) && typeof value['exists'] === 'boolean';
    case 'value':
      return isAssertTarget(value['target']) && typeof value['equals'] === 'string';
    default:
      return false;
  }
}

function isAssertTarget(value: unknown): boolean {
  return isSemanticTarget(value) && (value as SemanticTarget).css === undefined;
}

function isSemanticTargetUrl(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  let hasField = false;
  for (const field of TARGET_URL_FIELDS) {
    const candidate = value[field];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== 'string') {
      return false;
    }
    hasField = true;
  }
  return hasField;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}
