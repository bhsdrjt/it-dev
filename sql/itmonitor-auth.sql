-- Run explicitly on same SQL Server. No users/passwords seeded.
IF DB_ID(N'ITMonitor') IS NULL CREATE DATABASE ITMonitor;
GO
USE ITMonitor;
GO
SET XACT_ABORT ON;
BEGIN TRY
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.AuthUsers', N'U') IS NULL
CREATE TABLE dbo.AuthUsers (
 Id int IDENTITY PRIMARY KEY, Username nvarchar(200) NOT NULL UNIQUE,
 DisplayName nvarchar(200) NOT NULL, PasswordHash varchar(200) NOT NULL,
 IsActive bit NOT NULL DEFAULT 1, TokenVersion int NOT NULL DEFAULT 1,
 CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);
IF OBJECT_ID(N'dbo.AuthRoles', N'U') IS NULL
CREATE TABLE dbo.AuthRoles (Id int IDENTITY PRIMARY KEY, Name nvarchar(100) NOT NULL UNIQUE);
IF OBJECT_ID(N'dbo.AuthPermissions', N'U') IS NULL
CREATE TABLE dbo.AuthPermissions (Id int IDENTITY PRIMARY KEY, Name nvarchar(100) NOT NULL UNIQUE);
IF OBJECT_ID(N'dbo.AuthUserRoles', N'U') IS NULL
CREATE TABLE dbo.AuthUserRoles (UserId int NOT NULL REFERENCES dbo.AuthUsers(Id), RoleId int NOT NULL REFERENCES dbo.AuthRoles(Id), PRIMARY KEY(UserId,RoleId));
IF OBJECT_ID(N'dbo.AuthRolePermissions', N'U') IS NULL
CREATE TABLE dbo.AuthRolePermissions (RoleId int NOT NULL REFERENCES dbo.AuthRoles(Id), PermissionId int NOT NULL REFERENCES dbo.AuthPermissions(Id), PRIMARY KEY(RoleId,PermissionId));
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
-- dbo.Auth* prefix keeps auth tables distinct from operational schemas.
DECLARE @newRoles TABLE(Id int, Name nvarchar(100));
INSERT dbo.AuthRoles(Name) OUTPUT inserted.Id, inserted.Name INTO @newRoles
SELECT Name FROM (VALUES(N'admin'),(N'it_operator'),(N'transaction_operator'),(N'coal_editor'),(N'viewer')) v(Name)
WHERE NOT EXISTS(SELECT 1 FROM dbo.AuthRoles r WHERE r.Name=v.Name);
INSERT dbo.AuthPermissions(Name)
SELECT Name FROM (VALUES
 (N'equipment.view'),(N'equipment.manage_pc'),(N'equipment.ping'),(N'equipment.configure'),(N'monitoring.view'),
 (N'transactions.view'),(N'transactions.copy_loading'),(N'transactions.generate_receipt'),(N'transactions.pair'),
 (N'transactions.unpair'),(N'transactions.replay_raw'),(N'transactions.delete'),(N'transactions.restore'),
 (N'timeline.view'),(N'coal.view'),(N'coal.update'),(N'coal.import'),(N'coal.export'),(N'coal.delete'),
 (N'activity.view'),(N'access.manage')
) v(Name) WHERE NOT EXISTS(SELECT 1 FROM dbo.AuthPermissions p WHERE p.Name=v.Name);
-- Seed newly created roles only: reruns must not restore grants revoked by administrators.
INSERT dbo.AuthRolePermissions(RoleId,PermissionId)
SELECT r.Id,p.Id FROM @newRoles r CROSS JOIN dbo.AuthPermissions p
WHERE p.Name <> N'biostar.import' AND (
 r.Name=N'admin'
 OR p.Name LIKE N'%.view'
 OR (r.Name=N'it_operator' AND p.Name IN(N'equipment.manage_pc',N'equipment.ping',N'equipment.configure'))
 OR (r.Name=N'transaction_operator' AND p.Name IN(N'transactions.copy_loading',N'transactions.generate_receipt',N'transactions.pair',N'transactions.unpair',N'transactions.replay_raw'))
 OR (r.Name=N'coal_editor' AND p.Name IN(N'coal.update',N'coal.import',N'coal.export')));
-- Full BioStar import access is assigned explicitly by an administrator.
IF NOT EXISTS(SELECT 1 FROM dbo.AuthPermissions WHERE Name=N'biostar.import')
 INSERT dbo.AuthPermissions(Name) VALUES(N'biostar.import');
COMMIT;
END TRY
BEGIN CATCH
 IF @@TRANCOUNT > 0 ROLLBACK;
 THROW;
END CATCH;
GO
