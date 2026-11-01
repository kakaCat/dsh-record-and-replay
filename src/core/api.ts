/**
 * Core 公共 API：Host / Driver / Store / Replay / UI 之间共享类型与常量的唯一稳定入口。
 *
 * 边界（design/architecture.md 模块表）：
 * - 只放跨模块公共的纯类型、常量与纯函数；不含任何存储、进程或浏览器实现；
 * - 不依赖 Electron、Cua、Cordis，也不依赖 node:fs 等运行环境能力；
 * - 下游模块一律从 `core`（本文件）取类型，不回手抄设计文档里的类型定义。
 *
 * 导出面：
 * - JSON 基础类型、Principal、Origin、OperationContext；
 * - 六类 BrowserAction、SemanticTarget（actions.ts）；
 * - 七个稳定错误码、PublicError（errors.ts）；
 * - 稳定 ID 及其生成/校验（ids.ts）；
 * - schema/API 版本常量（version.ts）。
 */

import type { RecordingId, RunId } from './ids.js';

/** JSON 原始值。 */
export type JsonPrimitive = string | number | boolean | null;

/** 可持久化、可跨进程传递的 JSON 值。 */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** JSON 对象（只读视图）。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** 已认证的身份：由 Host 生成，不接受调用方任意传值。 */
export interface Principal {
  readonly sessionId: string;
  readonly agentId: string;
}

/** 动作来源：Agent 主动执行 / 回放执行 / 系统内部（如恢复、重绑）。 */
export type Origin = 'agent' | 'replay' | 'internal';

/** 每次工具调用的上下文；ID 是审计与错误定位的锚点。 */
export interface OperationContext {
  readonly principal: Principal;
  readonly callId: string;
  readonly origin: Origin;
  readonly recordingId?: RecordingId;
  readonly runId?: RunId;
  readonly signal: AbortSignal;
}

export * from './actions.js';
export * from './errors.js';
export * from './ids.js';
export * from './version.js';
