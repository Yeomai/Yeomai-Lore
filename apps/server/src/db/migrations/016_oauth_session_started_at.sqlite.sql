ALTER TABLE oauth_refresh_tokens
  ADD COLUMN session_started_at TEXT;

UPDATE oauth_refresh_tokens
   SET session_started_at = COALESCE(
         (
           SELECT MIN(history.created_at)
             FROM oauth_refresh_tokens history
            WHERE history.oauth_session_id = oauth_refresh_tokens.oauth_session_id
         ),
         created_at
       )
 WHERE session_started_at IS NULL OR session_started_at = '';
