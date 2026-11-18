-- Engage can connect accounts across every supported channel without a plan cap.
-- Keep the original migration intact for databases where it is already applied.
DROP TRIGGER IF EXISTS engage_connection_limit ON "SocialConnection";
DROP FUNCTION IF EXISTS enforce_engage_connection_limit();
