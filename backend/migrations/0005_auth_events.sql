-- Auth events audit log and configurable brute-force rate limiting.

CREATE TABLE IF NOT EXISTS auth_events (
  id          BIGSERIAL    PRIMARY KEY,
  event_type  VARCHAR(30)  NOT NULL,
  username    VARCHAR(120),
  user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  ip          VARCHAR(45),
  success     BOOLEAN      NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_events_created_at ON auth_events (created_at DESC);

INSERT INTO system_settings (key, value, updated_at)
  VALUES ('auth_max_attempts', '10', NOW())
  ON CONFLICT (key) DO NOTHING;

INSERT INTO system_settings (key, value, updated_at)
  VALUES ('auth_window_minutes', '15', NOW())
  ON CONFLICT (key) DO NOTHING;
