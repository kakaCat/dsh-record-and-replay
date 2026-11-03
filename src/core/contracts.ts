/**
 * Cross-module contract constants and the JSON Schemas generated from them.
 *
 * Why this file exists: launch modes, action kinds and the shape of locator /
 * window targets used to be hand-written in the tool schemas, the handlers,
 * the driver capability tables and the test-suite parser. Adding `desktop`
 * (launch), `key` (capability) or a target field then required synchronised
 * edits in several files, and missing one was only caught at runtime.
 *
 * The constants below are the single source of truth:
 * - `LAUNCH_MODES`            -> `LaunchMode`, bind/replay schemas, handlers, suite parser;
 * - `ACTION_SPECS`/`ACTION_KINDS` -> action schema, strict key validation, capability tables;
 * - `TARGET_FIELD_SCHEMAS`    -> locator schema and key validation;
 * - `WINDOW_TARGET_FIELD_SCHEMAS` -> bind/replay/suite target properties.
 *
 * This module is pure data + pure functions (no Node/Electron/Cua imports), so
 * `core` stays the dependency-free contract layer.
 */

/** Loose JSON Schema shape; values are JSON, not arbitrary objects. */
export type JsonSchema = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Launch modes (bind / replay / test suite target)
// ---------------------------------------------------------------------------

/** How a binding is created. Order is the order shown to callers. */
export const LAUNCH_MODES = ['existing', 'isolated', 'desktop'] as const;

export type LaunchMode = (typeof LAUNCH_MODES)[number];
export type ExistingLaunchMode = Extract<LaunchMode, 'existing'>;
export type IsolatedLaunchMode = Extract<LaunchMode, 'isolated'>;
export type DesktopLaunchMode = Extract<LaunchMode, 'desktop'>;

export const DEFAULT_LAUNCH_MODE: ExistingLaunchMode = 'existing';

export function isLaunchMode(value: unknown): value is LaunchMode {
  return typeof value === 'string' && (LAUNCH_MODES as readonly string[]).includes(value);
}

/** `"existing", "isolated" or "desktop"` — used verbatim in INVALID_ARGUMENT messages. */
export function formatLaunchModes(): string {
  const quoted = LAUNCH_MODES.map(mode => `"${mode}"`);
  const last = quoted.at(-1);
  if (last === undefined) return '';
  const head = quoted.slice(0, -1);
  return head.length === 0 ? last : `${head.join(', ')} or ${last}`;
}

export const LAUNCH_MODE_ERROR = `launch must be ${formatLaunchModes()}`;

export function launchModeSchema(description: string): JsonSchema {
  return { enum: [...LAUNCH_MODES], default: DEFAULT_LAUNCH_MODE, description };
}

// ---------------------------------------------------------------------------
// Profile names (isolated launch only)
// ---------------------------------------------------------------------------

/** JSON Schema pattern; the RegExp below is built from it so both stay in sync. */
export const PROFILE_NAME_PATTERN = '^[A-Za-z0-9._-]{1,64}$';
export const PROFILE_NAME_MAX_LENGTH = 64;

const PROFILE_NAME_REGEX = new RegExp(PROFILE_NAME_PATTERN, 'u');

export function isProfileName(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_NAME_REGEX.test(value);
}

// ---------------------------------------------------------------------------
// Semantic locator target (core/actions.ts `SemanticTarget`)
// ---------------------------------------------------------------------------

export const TARGET_URL_FIELD_SCHEMAS = {
  origin: { type: 'string' },
  path: { type: 'string' },
} as const;

export type TargetUrlField = keyof typeof TARGET_URL_FIELD_SCHEMAS;

export const TARGET_URL_FIELDS = Object.keys(TARGET_URL_FIELD_SCHEMAS) as readonly TargetUrlField[];

export function targetUrlSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: TARGET_URL_FIELD_SCHEMAS,
  };
}

/**
 * Field order is the documented locator order. Adding a field here is enough
 * for the JSON Schema and the handler's unknown-key rejection; `SemanticTarget`
 * in `core/actions.ts` is compile-time-checked against this list.
 */
export const TARGET_FIELD_SCHEMAS = {
  url: targetUrlSchema(),
  role: { type: 'string', minLength: 1 },
  name: { type: 'string', minLength: 1 },
  text: { type: 'string', minLength: 1 },
  index: { type: 'integer', minimum: 0, description: '0-based pick when several elements match.' },
  css: { type: 'string', minLength: 1 },
  extensions: { type: 'object' },
} as const;

export type TargetField = keyof typeof TARGET_FIELD_SCHEMAS;

export const TARGET_FIELDS = Object.keys(TARGET_FIELD_SCHEMAS) as readonly TargetField[];

export function targetSchema(
  description = 'Semantic locator: url origin/path plus role/name/text (css is declared but unsupported by the Cua V1 driver).',
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    description,
    properties: TARGET_FIELD_SCHEMAS,
  };
}

/** Locator fields implemented by the Cua browser driver (css is schema-only for now). */
export const CUA_LOCATOR_FIELDS = ['role', 'name', 'text', 'url'] as const;
export type CuaLocatorField = (typeof CUA_LOCATOR_FIELDS)[number];

// ---------------------------------------------------------------------------
// Window target (launch + pid/windowId + profileName)
// ---------------------------------------------------------------------------

/**
 * Shared by `cua_record_bind_browser`, `cua_replay_start`, test-suite targets
 * and the CLI `--launch/--pid/--window-id` override. Keeping one property map
 * means a new field appears in every surface at once.
 */
export const WINDOW_TARGET_FIELD_SCHEMAS = {
  launch: launchModeSchema(
    'existing (default) attaches to an existing pid/windowId; isolated launches a fresh driver-owned Chromium; desktop binds a macOS AX window.',
  ),
  pid: {
    type: 'integer',
    minimum: 1,
    description: 'OS process id of the browser/desktop window (existing/desktop only).',
  },
  windowId: {
    type: 'integer',
    minimum: 1,
    description: 'Native window id owned by that process (existing/desktop only).',
  },
  profileName: {
    type: 'string',
    minLength: 1,
    maxLength: PROFILE_NAME_MAX_LENGTH,
    pattern: PROFILE_NAME_PATTERN,
    description: 'isolated only: reuse a named driver-owned profile so cookies and logins persist across runs.',
  },
} as const;

export type WindowTargetField = keyof typeof WINDOW_TARGET_FIELD_SCHEMAS;

export const WINDOW_TARGET_FIELDS = Object.keys(WINDOW_TARGET_FIELD_SCHEMAS) as readonly WindowTargetField[];

/**
 * Loose runtime target shared by bind requests and test-suite overrides.
 * `ReplayTarget` in `host/service.ts` keeps a stricter discriminated union
 * because isolated targets must not carry pid/windowId.
 */
export interface WindowTarget {
  readonly launch?: LaunchMode;
  readonly pid?: number;
  readonly windowId?: number;
  /** Isolated only: reuse a named driver-owned profile so logins persist. */
  readonly profileName?: string;
}

export function windowTargetProperties(): Readonly<Record<string, JsonSchema>> {
  return WINDOW_TARGET_FIELD_SCHEMAS;
}

export function windowTargetSchema(description?: string): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: WINDOW_TARGET_FIELD_SCHEMAS,
    ...(description === undefined ? {} : { description }),
  };
}

// ---------------------------------------------------------------------------
// wait conditions
// ---------------------------------------------------------------------------

export const WAIT_CONDITION_KINDS = ['text', 'css', 'url', 'idle'] as const;
export type WaitConditionKind = (typeof WAIT_CONDITION_KINDS)[number];

export const WAIT_CONDITION_FIELD_SCHEMAS = {
  kind: { enum: [...WAIT_CONDITION_KINDS] },
  text: { type: 'string', minLength: 1 },
  css: { type: 'string', minLength: 1 },
  url: { type: 'string', minLength: 1 },
  quietMs: { type: 'number', exclusiveMinimum: 0 },
} as const;

export type WaitConditionField = keyof typeof WAIT_CONDITION_FIELD_SCHEMAS;

export const WAIT_CONDITION_FIELDS = Object.keys(WAIT_CONDITION_FIELD_SCHEMAS) as readonly WaitConditionField[];

export function waitConditionSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: WAIT_CONDITION_FIELD_SCHEMAS,
  };
}

// ---------------------------------------------------------------------------
// assert checks
// ---------------------------------------------------------------------------

/** One field in a discriminated-union variant (JSON Schema + required flag). */
export interface FieldSpec {
  readonly required?: boolean;
  readonly schema: JsonSchema;
}

/** One discriminated-union variant: a closed object with a `kind` discriminator. */
export interface VariantSpec {
  readonly description?: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

function variantObjectSchema(spec: VariantSpec): JsonSchema {
  const required: string[] = [];
  const properties: Record<string, JsonSchema> = {};
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    properties[field] = fieldSpec.schema;
    if (fieldSpec.required === true) required.push(field);
  }
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
    properties,
    ...(spec.description === undefined ? {} : { description: spec.description }),
  };
}

function variantUnionSchema(variants: readonly VariantSpec[], description?: string): JsonSchema {
  return {
    type: 'object',
    ...(description === undefined ? {} : { description }),
    oneOf: variants.map(variantObjectSchema),
  };
}

export const ASSERT_CHECK_SPECS = {
  url: {
    fields: {
      kind: { required: true, schema: { const: 'url' } },
      contains: { required: true, schema: { type: 'string', minLength: 1 } },
    },
  },
  text: {
    fields: {
      kind: { required: true, schema: { const: 'text' } },
      contains: { required: true, schema: { type: 'string', minLength: 1 } },
    },
  },
  element: {
    fields: {
      kind: { required: true, schema: { const: 'element' } },
      target: { required: true, schema: targetSchema() },
      exists: { required: true, schema: { type: 'boolean' } },
    },
  },
  value: {
    fields: {
      kind: { required: true, schema: { const: 'value' } },
      target: { required: true, schema: targetSchema() },
      equals: { required: true, schema: { type: 'string' } },
    },
  },
} as const satisfies Record<string, VariantSpec>;

export type AssertCheckKind = keyof typeof ASSERT_CHECK_SPECS;

export const ASSERT_CHECK_KINDS = Object.keys(ASSERT_CHECK_SPECS) as readonly AssertCheckKind[];

export function assertCheckFieldNames(kind: AssertCheckKind): readonly string[] {
  return Object.keys(ASSERT_CHECK_SPECS[kind].fields);
}

export function assertCheckSchema(): JsonSchema {
  return variantUnionSchema(ASSERT_CHECK_KINDS.map(kind => ASSERT_CHECK_SPECS[kind]));
}

// ---------------------------------------------------------------------------
// Browser actions
// ---------------------------------------------------------------------------

/** navigate is limited to http/https/about (same constraint as Cua's browser_navigate). */
export const NAVIGABLE_URL_PATTERN = '^(?:https?://|about:)';

const NAVIGABLE_URL_REGEX = new RegExp(NAVIGABLE_URL_PATTERN, 'iu');

export function isNavigableUrl(value: unknown): value is string {
  return typeof value === 'string' && NAVIGABLE_URL_REGEX.test(value);
}

export interface ActionSpec extends VariantSpec {
  /**
   * Whether the Cua browser driver advertises this action. Kinds that are
   * modelled but not mapped to Cua yet set this to false; everything else is
   * advertised automatically (adding a kind therefore touches one map entry).
   */
  readonly cuaBrowser?: boolean;
  /**
   * Whether the Cua desktop (macOS AX) binding advertises this action. Defaults
   * to true; navigate/wait have no desktop route.
   */
  readonly cuaDesktop?: boolean;
}

/**
 * The single action definition. `kind` is the discriminator; every other field
 * carries both its JSON Schema and whether it is required. Order is the
 * documented order and is exposed by `ACTION_KINDS`.
 */
export const ACTION_SPECS = {
  navigate: {
    description: 'Navigate to an http(s) or about: URL.',
    cuaDesktop: false,
    fields: {
      kind: { required: true, schema: { const: 'navigate' } },
      url: { required: true, schema: { type: 'string', pattern: NAVIGABLE_URL_PATTERN } },
    },
  },
  click: {
    description: 'Click one resolved semantic target.',
    fields: {
      kind: { required: true, schema: { const: 'click' } },
      target: { required: true, schema: targetSchema() },
      button: { required: false, schema: { enum: ['left', 'right'] } },
      count: { required: false, schema: { type: 'integer', minimum: 1, maximum: 3 } },
    },
  },
  setValue: {
    description: 'Set the value of one resolved semantic target.',
    fields: {
      kind: { required: true, schema: { const: 'setValue' } },
      target: { required: true, schema: targetSchema() },
      value: {
        required: true,
        schema: {
          type: 'string',
          description: 'Plaintext stays in-process; the recording layer redacts before persisting.',
        },
      },
      secretRef: { schema: { type: 'string', minLength: 1 } },
    },
  },
  drag: {
    description: 'Drag from one semantic target to another (browser: browser_pointer refs; desktop: window-local pixels).',
    fields: {
      kind: { required: true, schema: { const: 'drag' } },
      from: { required: true, schema: targetSchema() },
      to: { required: true, schema: targetSchema() },
    },
  },
  scroll: {
    description:
      'Scroll by deltaX/deltaY CSS pixels: browser bindings scroll at the target ref, or at the viewport centre when no target is given; desktop bindings send a wheel gesture.',
    fields: {
      kind: { required: true, schema: { const: 'scroll' } },
      target: { schema: targetSchema() },
      deltaX: { required: true, schema: { type: 'number' } },
      deltaY: { required: true, schema: { type: 'number' } },
    },
  },
  key: {
    description:
      'Press one key. Desktop bindings map this to an AX key press; Cua 0.38 has no browser-scoped key injection, so browser bindings refuse it.',
    cuaBrowser: false,
    fields: {
      kind: { required: true, schema: { const: 'key' } },
      target: { schema: targetSchema() },
      key: { required: true, schema: { type: 'string', minLength: 1 } },
    },
  },
  wait: {
    description: 'Wait for a page condition.',
    cuaBrowser: false,
    cuaDesktop: false,
    fields: {
      kind: { required: true, schema: { const: 'wait' } },
      condition: { required: true, schema: waitConditionSchema() },
      timeoutMs: { required: true, schema: { type: 'number', exclusiveMinimum: 0 } },
    },
  },
  assert: {
    description: 'Assert a read-only page condition.',
    fields: {
      kind: { required: true, schema: { const: 'assert' } },
      check: { required: true, schema: assertCheckSchema() },
    },
  },
} as const satisfies Record<string, ActionSpec>;

export type ActionKind = keyof typeof ACTION_SPECS;

export const ACTION_KINDS = Object.keys(ACTION_SPECS) as readonly ActionKind[];

/** Field names accepted for one action kind; used for strict unknown-key rejection. */
export function actionFieldNames(kind: ActionKind): readonly string[] {
  return Object.keys(ACTION_SPECS[kind].fields);
}

export function actionSchema(): JsonSchema {
  return variantUnionSchema(ACTION_KINDS.map(kind => ACTION_SPECS[kind]));
}

/**
 * Actions the Cua browser driver advertises. Derived from the action map so a
 * new modelled kind is advertised by default; mark it `cuaBrowser: false` when
 * the driver cannot execute it yet.
 */
export const CUA_BROWSER_ACTION_KINDS: readonly ActionKind[] = ACTION_KINDS.filter((kind) => {
  const spec: ActionSpec = ACTION_SPECS[kind];
  return spec.cuaBrowser !== false;
});

/**
 * Actions the Cua desktop (macOS AX) binding advertises. Desktop has no page
 * URL and no wait condition, but it can press a real key — which the browser
 * binding cannot — so the two lists are deliberately different.
 */
export const CUA_DESKTOP_ACTION_KINDS: readonly ActionKind[] = ACTION_KINDS.filter((kind) => {
  const spec: ActionSpec = ACTION_SPECS[kind];
  return spec.cuaDesktop !== false;
});
