/**
 * Core 版本常量。
 *
 * - `SCHEMA_VERSION` 是 Recording/Run JSONL 持久 schema 的版本（design/data-model.md）。
 * - `CORE_API_VERSION` 是公共 Core API 的 semver（interfaces.md：公共方法随 npm semver 演进）；
 *   Host Remote 的 apiVersion 独立版本化，不在这里声明。
 *
 * 兼容性承诺：读取方必须接受 `SUPPORTED_SCHEMA_VERSIONS` 内的全部版本；不认识的版本返回
 * `UNSUPPORTED_VERSION`，不得猜测或静默降级。
 */

/** 当前写入方产出的持久 schema 版本。 */
export const SCHEMA_VERSION = 1 as const;

/** `SCHEMA_VERSION` 的窄类型（字面量 1）。 */
export type SchemaVersion = typeof SCHEMA_VERSION;

/** 读取方必须支持的 schema 版本集合。 */
export const SUPPORTED_SCHEMA_VERSIONS = [SCHEMA_VERSION] as const;

/** Core 公共 API 的 semver；首个发布前保持在 0.x。 */
export const CORE_API_VERSION = '0.1.0' as const;

/** 包名（单包多入口的根包名，见 implementation-plan.md）。 */
export const CORE_PACKAGE_NAME = 'dsh-record-replay' as const;

/** 判断一个外部读入的 schemaVersion 是否在支持范围内。 */
export function isSupportedSchemaVersion(value: unknown): value is SchemaVersion {
  return typeof value === 'number' && (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(value);
}
