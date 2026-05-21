ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS server_search_enabled boolean NOT NULL DEFAULT false;
