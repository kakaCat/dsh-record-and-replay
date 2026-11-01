export {
  BrowserDriverError,
  type ActionResult,
  type BindBrowserInput,
  type BrowserBinding,
  type BrowserDriver,
  type DriverCapabilities,
  type Observation,
  type ObservationElement,
  type ResolvedTarget,
} from './api.js'
export { TargetMutex } from './mutex.js'
export { ReferenceTable } from './references.js'
export {
  ExtensionRegistry,
  ExtensionRegistryError,
  EXTENSION_KINDS,
  EXTENSION_REGISTRY_CODES,
  type ExtensionDisposable,
  type ExtensionKind,
  type ExtensionRegistryCode,
  type RegisteredExtension,
} from './registry.js'
export {
  OperationRunner,
  type OperationEventSink,
  type OperationOutcome,
  type OperationRequest,
  type OperationRunnerOptions,
  type OperationStepEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
  type StepStatus,
} from './operation-runner.js'
