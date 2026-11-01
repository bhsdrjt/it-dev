-- Run explicitly against ITMonitor after auth setup; never run automatically at server startup.
USE ITMonitor;
GO
SET XACT_ABORT ON;
BEGIN TRY
 BEGIN TRANSACTION;
 -- BEGIN USER AUDIT MIGRATION (also used by itmonitor-auth.sql)
 IF OBJECT_ID(N'dbo.AuthAudit') IS NOT NULL AND OBJECT_ID(N'dbo.UserAudit') IS NOT NULL
  THROW 50003, 'Both AuthAudit and UserAudit exist; reconcile manually before migration.', 1;
 IF OBJECT_ID(N'dbo.UserAudit') IS NULL AND OBJECT_ID(N'dbo.AuthAudit', N'U') IS NOT NULL
  EXEC sys.sp_rename N'dbo.AuthAudit', N'UserAudit';
 IF OBJECT_ID(N'dbo.UserAudit') IS NULL
 CREATE TABLE dbo.UserAudit (
  Id bigint IDENTITY PRIMARY KEY, ActorUserId int NULL REFERENCES dbo.AuthUsers(Id),
  Action nvarchar(100) NOT NULL, Target nvarchar(max) NOT NULL,
  OperationId varchar(32) NULL, Outcome varchar(20) NOT NULL DEFAULT 'succeeded',
  CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
 );
 IF OBJECT_ID(N'dbo.UserAudit', N'U') IS NULL
  THROW 50004, 'UserAudit must be a table.', 1;
 -- Dynamic batches resolve renamed tables and newly added columns on existing installations.
 EXEC(N'ALTER TABLE dbo.UserAudit ALTER COLUMN Target nvarchar(max) NOT NULL;');
 IF COL_LENGTH(N'dbo.UserAudit', N'OperationId') IS NULL
  EXEC(N'ALTER TABLE dbo.UserAudit ADD OperationId varchar(32) NULL;');
 IF COL_LENGTH(N'dbo.UserAudit', N'Outcome') IS NULL
  EXEC(N'ALTER TABLE dbo.UserAudit ADD Outcome varchar(20) NOT NULL DEFAULT ''succeeded'' WITH VALUES;');
 EXEC(N'
  IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N''dbo.UserAudit'') AND name=N''IX_UserAudit_Actor_CreatedAt'')
   CREATE INDEX IX_UserAudit_Actor_CreatedAt ON dbo.UserAudit(ActorUserId, CreatedAt DESC);
  IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N''dbo.UserAudit'') AND name=N''IX_UserAudit_OperationId'')
   CREATE INDEX IX_UserAudit_OperationId ON dbo.UserAudit(OperationId) WHERE OperationId IS NOT NULL;
  IF NOT EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N''dbo.UserAudit'') AND name=N''CK_UserAudit_Outcome'')
   AND NOT EXISTS(SELECT 1 FROM dbo.UserAudit WHERE Outcome IS NULL OR Outcome NOT IN (''started'',''succeeded'',''failed'',''unknown''))
   ALTER TABLE dbo.UserAudit WITH CHECK ADD CONSTRAINT CK_UserAudit_Outcome CHECK (Outcome IN (''started'',''succeeded'',''failed'',''unknown''));
 ');
 -- END USER AUDIT MIGRATION
 COMMIT;
END TRY
BEGIN CATCH
 IF @@TRANCOUNT > 0 ROLLBACK;
 THROW;
END CATCH;
GO
