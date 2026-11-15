-- Apply database/schema.sql for the full schema. This migration marker records its version.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT IGNORE INTO schema_migrations (version) VALUES ('001_initial_schema');
