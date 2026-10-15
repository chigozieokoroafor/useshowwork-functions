-- READ ONLY; execute only after production database access is separately approved.
-- Output is review material, never automatic permission to apply proposals.
BEGIN READ ONLY;
SELECT current_database(),current_user,current_schema(),current_setting('transaction_isolation');
SELECT table_schema,table_name,column_name,data_type,is_nullable
 FROM information_schema.columns
 WHERE table_schema=current_schema() AND (table_name LIKE 'Publishing%' OR table_name IN ('CalendarPost','CalendarPostAsset','SocialConnection','SocialCalendar','Creator','CalendarCollaborator'))
 ORDER BY table_name,ordinal_position;
SELECT c.relname,con.conname,pg_get_constraintdef(con.oid) AS definition
 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema() AND c.relname LIKE 'Publishing%' ORDER BY c.relname,con.conname;
SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema() AND NOT t.tgisinternal ORDER BY c.relname,t.tgname;
SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user;
COMMIT;
