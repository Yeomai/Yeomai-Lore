ALTER TABLE oauth_refresh_tokens
  ADD COLUMN oauth_session_id TEXT;

UPDATE oauth_refresh_tokens
   SET oauth_session_id = token_hash
 WHERE oauth_session_id IS NULL OR oauth_session_id = '';

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_session_idx
  ON oauth_refresh_tokens (oauth_session_id);

UPDATE oauth_refresh_tokens
   SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE revoked_at IS NULL;

UPDATE users
   SET oauth_epoch = oauth_epoch + 1;
