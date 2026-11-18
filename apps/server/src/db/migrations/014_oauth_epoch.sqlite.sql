ALTER TABLE users
  ADD COLUMN oauth_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (oauth_epoch >= 0);
