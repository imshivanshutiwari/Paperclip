export {
  createDb,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export * from "./schema/index.js";
export {
  makeBypassRls,
  makeRlsPolicy,
  companyScope,
  agentSelfScope,
  companyAndCond,
  companyInScope,
  assertCompanyScope,
  withRlsAudit,
  isScopedPolicy,
  getPolicyCompanyId,
  RlsViolationError,
  type BypassRls,
  type RlsContext,
  type RlsPolicy,
  type CompanyScopedTable,
  type RlsAuditEntry,
  type RlsAuditLogger,
} from "./rls.js";
