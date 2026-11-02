USE ITMonitor;
GO
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;
  IF OBJECT_ID(N'dbo.ApiTargets', N'U') IS NULL
    CREATE TABLE dbo.ApiTargets (
      Id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_ApiTargets PRIMARY KEY,
      ApiName nvarchar(200) NOT NULL,
      IpAPI varchar(15) NOT NULL,
      LocationIDs nvarchar(max) NOT NULL,
      CONSTRAINT CK_ApiTargets_LocationIDs CHECK (ISJSON(LocationIDs)=1 AND LEFT(LTRIM(REPLACE(REPLACE(REPLACE(LocationIDs, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' ')),1)='[')
    );
  ELSE IF COLUMNPROPERTY(OBJECT_ID(N'dbo.ApiTargets'), N'Id', 'IsIdentity')<>1
    OR NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.ApiTargets') AND name=N'Id' AND system_type_id=56)
    THROW 50001, 'Existing registry needs sql/api-registry-identity.sql; no data changed.', 1;
  COMMIT;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK;
  THROW;
END CATCH;
GO
-- DBA: grant SELECT, INSERT, UPDATE, DELETE on dbo.ApiTargets to AUTH_DB_USER.
-- One runtime table; LocationIDs JSON preserves location order. SQL Server 2016+.
