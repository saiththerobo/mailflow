-- no-transaction
--
-- Extend search_vector to include body_text so full-text search covers email body content.
--
-- The previous generated column only indexed subject / from_name / from_email / snippet
-- (200-char preview). Adding left(body_text, 100000) means PostgreSQL automatically
-- recomputes search_vector whenever body_text is written — when the user opens a message,
-- when the snippet indexer runs, or when any future indexing path populates body content.
-- The GIN index then makes body-content searches as fast as subject/sender searches.
--
-- Generated column expressions cannot be altered in-place; the column must be dropped and
-- re-added. PostgreSQL recomputes the stored value for all existing rows during the ADD
-- COLUMN — fast because no data moves, only tsvectors are regenerated. For rows where
-- body_text is NULL the expression reduces to the previous formula (coalesce gives '').
--
-- Must be idempotent (IF NOT EXISTS / IF EXISTS) because a crash between the SQL and
-- the schema_migrations INSERT causes this migration to be retried on next startup.

ALTER TABLE messages DROP COLUMN IF EXISTS search_vector;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(subject, '') || ' ' ||
      coalesce(from_name, '') || ' ' ||
      coalesce(from_email, '') || ' ' ||
      coalesce(snippet, '') || ' ' ||
      coalesce(left(body_text, 100000), '')
    )
  ) STORED;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_search_vector;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_search_vector
  ON messages USING GIN (search_vector);
