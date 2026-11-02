USE ITMonitor;
GO
-- Manual upgrade only. Stop all writers and back up ITMonitor first.
-- Old table + ID map remain permanent, read-only migration artifacts for historic audit references.
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;
  IF OBJECT_ID(N'dbo.ApiTargets', N'U') IS NULL
    THROW 50001, 'Registry missing; use sql/api-registry.sql for fresh setup.', 1;
  IF COLUMNPROPERTY(OBJECT_ID(N'dbo.ApiTargets'), N'Id', 'IsIdentity')=1
    AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.ApiTargets') AND name=N'Id' AND system_type_id=56)
  BEGIN
    COMMIT;
    RETURN;
  END;
  IF OBJECT_ID(N'dbo.ApiTargets_LegacyIds') IS NOT NULL OR OBJECT_ID(N'dbo.ApiTargetIdMap') IS NOT NULL
    OR OBJECT_ID(N'dbo.ApiTargets_Identity') IS NOT NULL
    THROW 50002, 'Backup, map, or staging object exists; reconcile manually. Nothing overwritten.', 1;
  IF (SELECT COUNT(*) FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.ApiTargets'))<>4
    OR COL_LENGTH(N'dbo.ApiTargets', N'ApiName') IS NULL
    OR COL_LENGTH(N'dbo.ApiTargets', N'IpAPI') IS NULL
    OR COL_LENGTH(N'dbo.ApiTargets', N'LocationIDs') IS NULL
    OR NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.ApiTargets') AND name=N'Id' AND system_type_id IN (231,36))
    THROW 50003, 'Expected single-table string/UUID registry; unexpected schema needs manual review.', 1;
  IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE parent_object_id=OBJECT_ID(N'dbo.ApiTargets') OR referenced_object_id=OBJECT_ID(N'dbo.ApiTargets'))
    OR EXISTS (SELECT 1 FROM sys.triggers WHERE parent_id=OBJECT_ID(N'dbo.ApiTargets'))
    -- Local CHECK constraints reference their own table; they are not external consumers.
    -- Validated data is copied into the new table with its own JSON CHECK constraint.
    OR EXISTS (SELECT 1 FROM sys.sql_expression_dependencies d
      WHERE d.referenced_id=OBJECT_ID(N'dbo.ApiTargets')
        AND NOT EXISTS (SELECT 1 FROM sys.check_constraints c
          WHERE c.object_id=d.referencing_id AND c.parent_object_id=d.referenced_id
            AND c.name=N'CK_ApiTargets_LocationIDs'))
    THROW 50004, 'Registry dependencies need manual review before identity migration.', 1;

  DECLARE @count bigint;
  SELECT @count=COUNT_BIG(*) FROM dbo.ApiTargets WITH (TABLOCKX, HOLDLOCK);
  IF @count>=2147483647 THROW 50005, 'INT identity capacity exceeded.', 1;
  IF EXISTS (SELECT 1 FROM dbo.ApiTargets WHERE Id IS NULL OR LEN(CONVERT(nvarchar(max),Id))=0
    OR DATALENGTH(CONVERT(nvarchar(max),Id))>400 OR ApiName IS NULL OR IpAPI IS NULL
    OR LocationIDs IS NULL OR ISJSON(LocationIDs)<>1
    OR LEFT(LTRIM(REPLACE(REPLACE(REPLACE(LocationIDs, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' ')),1)<>'[')
    THROW 50006, 'Invalid registry data; migration cancelled.', 1;
  IF EXISTS (SELECT 1 FROM dbo.ApiTargets t CROSS APPLY OPENJSON(t.LocationIDs) j
    WHERE j.type<>2 OR TRY_CONVERT(int,j.value) IS NULL OR TRY_CONVERT(int,j.value)<0 OR j.value LIKE '%[^0-9]%')
    OR EXISTS (SELECT 1 FROM dbo.ApiTargets t CROSS APPLY OPENJSON(t.LocationIDs) j
      GROUP BY t.Id HAVING COUNT(*)>1000 OR COUNT(*)<>COUNT(DISTINCT TRY_CONVERT(int,j.value)))
    THROW 50007, 'Invalid or duplicate location IDs; migration cancelled.', 1;

  -- Distinct constraint names avoid collisions with retained backup constraints.
  CREATE TABLE dbo.ApiTargets_Identity (
    Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_ApiTargets_Identity PRIMARY KEY,
    ApiName nvarchar(200) NOT NULL,
    IpAPI varchar(15) NOT NULL,
    LocationIDs nvarchar(max) NOT NULL,
    CONSTRAINT CK_ApiTargets_Identity_LocationIDs CHECK (ISJSON(LocationIDs)=1 AND LEFT(LTRIM(REPLACE(REPLACE(REPLACE(LocationIDs, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' ')),1)='[')
  );
  CREATE TABLE dbo.ApiTargetIdMap (
    OldId nvarchar(200) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT PK_ApiTargetIdMap PRIMARY KEY,
    NewId int NOT NULL CONSTRAINT UQ_ApiTargetIdMap_NewId UNIQUE
  );
  -- Cursor makes identity assignment order explicit; JSON copied verbatim, never reordered.
  DECLARE @oldId nvarchar(200), @name nvarchar(200), @ip varchar(15), @locations nvarchar(max);
  DECLARE targets CURSOR LOCAL FAST_FORWARD FOR
    SELECT CONVERT(nvarchar(200),Id), ApiName, IpAPI, LocationIDs FROM dbo.ApiTargets ORDER BY ApiName, Id;
  OPEN targets;
  FETCH NEXT FROM targets INTO @oldId, @name, @ip, @locations;
  WHILE @@FETCH_STATUS=0
  BEGIN
    INSERT dbo.ApiTargets_Identity(ApiName,IpAPI,LocationIDs) VALUES(@name,@ip,@locations);
    INSERT dbo.ApiTargetIdMap(OldId,NewId) VALUES(@oldId,CONVERT(int,SCOPE_IDENTITY()));
    FETCH NEXT FROM targets INTO @oldId, @name, @ip, @locations;
  END;
  CLOSE targets;
  DEALLOCATE targets;
  IF (SELECT COUNT_BIG(*) FROM dbo.ApiTargets_Identity)<>@count OR (SELECT COUNT_BIG(*) FROM dbo.ApiTargetIdMap)<>@count
    THROW 50008, 'Copy count mismatch; migration cancelled.', 1;
  IF EXISTS (SELECT 1 FROM dbo.ApiTargets old
    JOIN dbo.ApiTargetIdMap m ON m.OldId=CONVERT(nvarchar(200),old.Id) COLLATE Latin1_General_100_BIN2
    JOIN dbo.ApiTargets_Identity new ON new.Id=m.NewId
    WHERE CONVERT(varbinary(max),old.ApiName)<>CONVERT(varbinary(max),new.ApiName)
      OR CONVERT(varbinary(max),old.IpAPI)<>CONVERT(varbinary(max),new.IpAPI)
      OR CONVERT(varbinary(max),old.LocationIDs)<>CONVERT(varbinary(max),new.LocationIDs))
    THROW 50009, 'Copy content mismatch; migration cancelled.', 1;
  EXEC sys.sp_rename N'dbo.ApiTargets', N'ApiTargets_LegacyIds';
  EXEC sys.sp_rename N'dbo.ApiTargets_Identity', N'ApiTargets';
  COMMIT;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK;
  THROW;
END CATCH;
GO
-- Grants attach to object IDs: DBA must grant runtime CRUD on NEW dbo.ApiTargets,
-- and remove runtime writes from dbo.ApiTargets_LegacyIds. No runtime access to map needed.
-- Do not rewrite UserAudit. Resolve historic IDs through dbo.ApiTargetIdMap.OldId/NewId.
