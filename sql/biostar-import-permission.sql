-- Run as DBA with backend stopped, after backing up ITMonitor.
-- Only roles with biostar.import.start inherit full import access.
USE ITMonitor;
GO
SET XACT_ABORT ON;
BEGIN TRY
 BEGIN TRANSACTION;
 IF NOT EXISTS (SELECT 1 FROM dbo.AuthPermissions WITH (UPDLOCK, HOLDLOCK) WHERE Name = N'biostar.import')
  INSERT dbo.AuthPermissions(Name) VALUES(N'biostar.import');
 DECLARE @permissionId int = (SELECT Id FROM dbo.AuthPermissions WHERE Name = N'biostar.import');

 INSERT dbo.AuthRolePermissions(RoleId, PermissionId)
 SELECT rp.RoleId, @permissionId
 FROM dbo.AuthRolePermissions rp
 JOIN dbo.AuthPermissions p ON p.Id = rp.PermissionId
 WHERE p.Name = N'biostar.import.start'
  AND NOT EXISTS (
   SELECT 1 FROM dbo.AuthRolePermissions existing WITH (UPDLOCK, HOLDLOCK)
   WHERE existing.RoleId = rp.RoleId AND existing.PermissionId = @permissionId
  );

 DECLARE @legacy TABLE(Id int PRIMARY KEY);
 INSERT @legacy(Id)
 SELECT Id FROM dbo.AuthPermissions WHERE Name IN (
  N'biostar.import.view', N'biostar.import.upload', N'biostar.import.mapping',
  N'biostar.import.validate', N'biostar.import.confirm', N'biostar.import.cancel',
  N'biostar.import.start', N'biostar.import.report'
 );
 DELETE rp FROM dbo.AuthRolePermissions rp JOIN @legacy p ON p.Id = rp.PermissionId;
 DELETE p FROM dbo.AuthPermissions p JOIN @legacy old ON old.Id = p.Id;
 COMMIT;
END TRY
BEGIN CATCH
 IF @@TRANCOUNT > 0 ROLLBACK;
 THROW;
END CATCH;
GO
-- Verify grants; existing unified grants are preserved on rerun.
SELECT r.Name AS RoleName, p.Name AS PermissionName
FROM dbo.AuthRolePermissions rp
JOIN dbo.AuthRoles r ON r.Id = rp.RoleId
JOIN dbo.AuthPermissions p ON p.Id = rp.PermissionId
WHERE p.Name = N'biostar.import'
ORDER BY r.Name;
