/**
 * Public API — exports all core modules.
 */
export * from './types.js';

export { StateStore } from './orchestrator/state-store.js';
export { isLegalTransition, validateTransition, isTerminal, allowedNextPhases, nextAfterVerification, nextAfterAudit, shouldFailAfterRework, StateMachineError } from './orchestrator/state-machine.js';

export { ArtifactStore, ARTIFACT_FILES, ARTIFACT_DIRS, VERSIONED_ARTIFACTS, LOCAL_ONLY_ARTIFACTS } from './artifacts/artifact-store.js';
export { parseFrontMatter, serializeFrontMatter, validateRequiredFields, validateEnumField, FrontMatterError } from './artifacts/front-matter.js';
export { parsePlan, parseGoal, parseHandoff, parseAuditReport, parseFinalAudit, parseIterationLog, validateIterationLogEntry } from './artifacts/artifact-schemas.js';
export { loadConfig, loadConfigWithDefaults, generateSampleConfig, validateMvpConstraints, DEFAULT_CONFIG, ConfigError } from './artifacts/config.js';

export { LockManager, LockManagerError } from './runtime/lock-manager.js';
export { atomicWriteFile, atomicWriteJSON } from './runtime/atomic-file.js';

export { createCLI } from './cli/index.js';