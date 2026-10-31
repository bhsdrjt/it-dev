/*
  Monitoring anomali transaksi — satu pintu untuk semua kode temuan.

  Menambah anomali baru: tambah satu blok UNION ALL di dalam CTE Temuan.
  Bentuk kolom hasil sudah cocok dengan tabel di web/AnomalyDashboard.tsx:
  code, severity, category, title, detail, cdn, truck, equipmentId, loadingId, dumpingId, eventAt.

  Contoh:
    EXEC dbo.usp_MonitoringAnomali @Mulai = '2026-01-01';
    EXEC dbo.usp_MonitoringAnomali @Mulai = '2026-01-01', @Kode = 'KIRIM_LOADING_LOCATION_KOSONG';
    EXEC dbo.usp_MonitoringAnomali @Mulai = DATEADD(DAY, -7, GETDATE()), @Truck = 'TR18';

  Index disarankan (jalankan di SQL Server jika query berat):
    CREATE INDEX IX_tabCTFinalLoadingTonnage_Dumping ON dbo.tabCTFinalLoadingTonnage (CTFinalDumpingTonnageID, dtDeletedAt, dtLoaded);
    CREATE INDEX IX_tabCTFinalDumpingTonnage_ID ON dbo.tabCTFinalDumpingTonnage (CTFinalDumpingTonnageID, dtDeletedAt, dtLoaded, dtEmpty, CoalDeliveryNumber);
*/
CREATE OR ALTER PROCEDURE dbo.usp_MonitoringAnomali
  @Mulai    datetime,
  @Selesai  datetime = NULL,          -- eksklusif; default sekarang
  @Kode     varchar(50) = NULL,       -- NULL = semua kode
  @Truck    varchar(50) = NULL,       -- cari sebagian pada strEquipmentName
  @Cdn      varchar(50) = NULL,       -- cari sebagian pada CoalDeliveryNumber
  @Severity varchar(10) = NULL,       -- 'critical' | 'warning'
  @Kategori varchar(20) = NULL,       -- 'pairing' | 'location' | 'time'
  @Limit    int = 500
AS
BEGIN
  SET NOCOUNT ON;
  IF @Selesai IS NULL SET @Selesai = GETDATE();
  IF @Mulai IS NULL SET @Mulai = DATEADD(DAY, -7, @Selesai);
  IF @Limit IS NULL OR @Limit <= 0 SET @Limit = 500;
  IF @Limit > 5000 SET @Limit = 5000;

  ;WITH UnpairedTerima AS (
    /* Terima yang belum ada Kirim yang menunjuk padanya (anti-join, set-based) */
    SELECT d.CTFinalDumpingTonnageID, d.dtLoaded
    FROM dbo.tabCTFinalDumpingTonnage AS d WITH (NOLOCK)
    LEFT JOIN dbo.tabCTFinalLoadingTonnage AS l2 WITH (NOLOCK)
      ON l2.CTFinalDumpingTonnageID = d.CTFinalDumpingTonnageID
    WHERE d.dtDeletedAt IS NULL
      AND l2.CTFinalLoadingTonnageID IS NULL
  ), UnpairedKirim AS (
    /* Kirim aktif yang belum berpasangan dengan Terima apa pun */
    SELECT l.CTFinalLoadingTonnageID, l.dtLoaded
    FROM dbo.tabCTFinalLoadingTonnage AS l WITH (NOLOCK)
    WHERE l.dtDeletedAt IS NULL
      AND l.CTFinalDumpingTonnageID IS NULL
  ), Temuan AS (
    /* 1. Kirim tanpa LoadingLocation */
    SELECT
      'KIRIM_LOADING_LOCATION_KOSONG' AS code,
      'warning'                       AS severity,
      'location'                      AS category,
      'LoadingLocation Kirim kosong'   AS title,
      CONCAT('Kirim #', l.CTFinalLoadingTonnageID, ' (', l.CoalDeliveryNumber,
             ') truck ', l.strEquipmentName, ' tidak memiliki LoadingLocation.') AS detail,
      l.CoalDeliveryNumber            AS cdn,
      l.strEquipmentName              AS truck,
      l.EquipmentID                   AS equipmentId,
      l.CTFinalLoadingTonnageID       AS loadingId,
      l.CTFinalDumpingTonnageID       AS dumpingId,
      l.dtLoaded                      AS eventAt
    FROM dbo.tabCTFinalLoadingTonnage AS l WITH (NOLOCK)
    WHERE l.LoadingLocationID IS NULL
      AND l.dtDeletedAt IS NULL
      AND l.dtLoaded >= @Mulai
      AND l.dtLoaded <  @Selesai

    /* 2. Kirim tanpa pasangan Terima, 2–7 hari */
    UNION ALL
    SELECT
      'KIRIM_TANPA_PASANGAN_2D',
      'critical',
      'pairing',
      'Kirim tanpa pasangan 2 hari',
      CONCAT('Kirim #', l.CTFinalLoadingTonnageID, ' (', l.CoalDeliveryNumber,
             ') truck ', l.strEquipmentName, ' sudah ',
             DATEDIFF(DAY, l.dtLoaded, GETDATE()), ' hari sejak muat tanpa Terima.'),
      l.CoalDeliveryNumber, l.strEquipmentName, l.EquipmentID,
      l.CTFinalLoadingTonnageID, l.CTFinalDumpingTonnageID, l.dtLoaded
    FROM dbo.tabCTFinalLoadingTonnage AS l WITH (NOLOCK)
    WHERE l.CTFinalDumpingTonnageID IS NULL
      AND l.dtDeletedAt IS NULL
      AND l.dtLoaded <  DATEADD(DAY, -2, GETDATE())
      AND l.dtLoaded >= DATEADD(DAY, -7, GETDATE())
      AND l.dtLoaded >= @Mulai
      AND l.dtLoaded <  @Selesai

    /* 3. Kirim tanpa pasangan Terima, lebih dari 7 hari */
    UNION ALL
    SELECT
      'KIRIM_TANPA_PASANGAN_7D',
      'critical',
      'pairing',
      'Kirim tanpa pasangan 7 hari',
      CONCAT('Kirim #', l.CTFinalLoadingTonnageID, ' (', l.CoalDeliveryNumber,
             ') truck ', l.strEquipmentName, ' sudah ',
             DATEDIFF(DAY, l.dtLoaded, GETDATE()), ' hari sejak muat tanpa Terima.'),
      l.CoalDeliveryNumber, l.strEquipmentName, l.EquipmentID,
      l.CTFinalLoadingTonnageID, l.CTFinalDumpingTonnageID, l.dtLoaded
    FROM dbo.tabCTFinalLoadingTonnage AS l WITH (NOLOCK)
    WHERE l.CTFinalDumpingTonnageID IS NULL
      AND l.dtDeletedAt IS NULL
      AND l.dtLoaded < DATEADD(DAY, -7, GETDATE())
      AND l.dtLoaded >= @Mulai
      AND l.dtLoaded <  @Selesai

    /* 4. Kirim berpasangan Terima yang sudah dihapus (soft delete) */
    UNION ALL
    SELECT
      'KIRIM_PASANGAN_TERIMA_DIHAPUS',
      'warning',
      'pairing',
      'Pasangan Terima sudah dihapus',
      CONCAT('Kirim #', l.CTFinalLoadingTonnageID, ' (', l.CoalDeliveryNumber,
             ') pasangannya Terima #', d.CTFinalDumpingTonnageID, ' sudah dihapus pada ', CONVERT(varchar, d.dtDeletedAt, 120), '.'),
      l.CoalDeliveryNumber, l.strEquipmentName, l.EquipmentID,
      l.CTFinalLoadingTonnageID, l.CTFinalDumpingTonnageID, l.dtLoaded
    FROM dbo.tabCTFinalLoadingTonnage AS l WITH (NOLOCK)
    JOIN dbo.tabCTFinalDumpingTonnage AS d WITH (NOLOCK)
      ON d.CTFinalDumpingTonnageID = l.CTFinalDumpingTonnageID
    WHERE l.CTFinalDumpingTonnageID IS NOT NULL
      AND l.dtDeletedAt IS NULL
      AND d.dtDeletedAt IS NOT NULL
      AND l.dtLoaded >= @Mulai
      AND l.dtLoaded <  @Selesai

    /* 5. Kirim berpasangan ke Terima selanjutnya, melewati Terima sebelumnya yang belum berpasangan */
    UNION ALL
    SELECT
      'KIRIM_PASANGAN_TERIMA_SELANJUTNYA',
      'warning',
      'pairing',
      'Kirim pasang ke Terima selanjutnya',
      CONCAT('Kirim #', l.CTFinalLoadingTonnageID, ' (', l.CoalDeliveryNumber,
             ') berpasangan dengan Terima #', l.CTFinalDumpingTonnageID,
             ', sehingga ada Terima sebelumnya yang belum berpasangan.'),
      l.CoalDeliveryNumber, l.strEquipmentName, l.EquipmentID,
      l.CTFinalLoadingTonnageID, l.CTFinalDumpingTonnageID, l.dtLoaded
    FROM dbo.tabCTFinalLoadingTonnage AS l WITH (NOLOCK)
    JOIN dbo.tabCTFinalDumpingTonnage AS d WITH (NOLOCK)
      ON d.CTFinalDumpingTonnageID = l.CTFinalDumpingTonnageID
    JOIN UnpairedTerima AS u
      ON u.CTFinalDumpingTonnageID < l.CTFinalDumpingTonnageID
     AND u.dtLoaded > l.dtLoaded
    WHERE l.CTFinalDumpingTonnageID IS NOT NULL
      AND l.dtDeletedAt IS NULL
      AND d.dtDeletedAt IS NULL
      AND l.dtLoaded >= @Mulai
      AND l.dtLoaded <  @Selesai

    /* 6. SK kirim berpasangan SK terima, namun di antara dtLoaded SK kirim dan dtEmpty SK terima ada SK kirim aktif yang belum berpasangan */
    UNION ALL
    SELECT
      'SK_KIRIM_TERIMA_DTEMPTY_SEBELUM_LOAD',
      'warning',
      'pairing',
      'Ada SK kirim aktif belum berpasangan di antara muat dan kosong',
      CONCAT('Kirim #', l.CTFinalLoadingTonnageID, ' (', l.CoalDeliveryNumber,
             ') berpasangan Terima #', d.CTFinalDumpingTonnageID,
             ', namun antara dtLoaded Kirim ', CONVERT(varchar, l.dtLoaded, 120),
             ' dan dtEmpty Terima ', CONVERT(varchar, d.dtEmpty, 120),
             ' ada SK kirim aktif yang belum berpasangan.'),
      l.CoalDeliveryNumber, l.strEquipmentName, l.EquipmentID,
      l.CTFinalLoadingTonnageID, l.CTFinalDumpingTonnageID, l.dtLoaded
    FROM dbo.tabCTFinalLoadingTonnage AS l WITH (NOLOCK)
    JOIN dbo.tabCTFinalDumpingTonnage AS d WITH (NOLOCK)
      ON d.CTFinalDumpingTonnageID = l.CTFinalDumpingTonnageID
    JOIN UnpairedKirim AS u
      ON u.dtLoaded > l.dtLoaded
     AND u.dtLoaded < d.dtEmpty
    WHERE l.CTFinalDumpingTonnageID IS NOT NULL
      AND l.dtDeletedAt IS NULL
      AND d.dtDeletedAt IS NULL
      AND d.dtEmpty > l.dtLoaded
      AND l.dtLoaded >= @Mulai
      AND l.dtLoaded <  @Selesai

    /* 7. SK kirim berpasangan SK terima yang CDN-nya berbeda */
    UNION ALL
    SELECT
      'SK_KIRIM_TERIMA_CDN_BERBEDA',
      'warning',
      'pairing',
      'CDN Kirim dan Terima tidak sama',
      CONCAT('Kirim #', l.CTFinalLoadingTonnageID, ' (', l.CoalDeliveryNumber,
             ') berpasangan Terima #', d.CTFinalDumpingTonnageID,
             ' (', d.CoalDeliveryNumber, ') — CDN berbeda.'),
      l.CoalDeliveryNumber, l.strEquipmentName, l.EquipmentID,
      l.CTFinalLoadingTonnageID, l.CTFinalDumpingTonnageID, l.dtLoaded
    FROM dbo.tabCTFinalLoadingTonnage AS l WITH (NOLOCK)
    JOIN dbo.tabCTFinalDumpingTonnage AS d WITH (NOLOCK)
      ON d.CTFinalDumpingTonnageID = l.CTFinalDumpingTonnageID
    WHERE l.CTFinalDumpingTonnageID IS NOT NULL
      AND l.dtDeletedAt IS NULL
      AND d.dtDeletedAt IS NULL
      AND l.CoalDeliveryNumber <> d.CoalDeliveryNumber
      AND l.dtLoaded >= @Mulai
      AND l.dtLoaded <  @Selesai
  )
  SELECT TOP (@Limit)
    code, severity, category, title, detail, cdn, truck, equipmentId, loadingId, dumpingId, eventAt
  FROM Temuan
  WHERE (@Kode     IS NULL OR code     = @Kode)
    AND (@Severity IS NULL OR severity = @Severity)
    AND (@Kategori IS NULL OR category = @Kategori)
    AND (@Truck    IS NULL OR truck LIKE '%' + @Truck + '%')
    AND (@Cdn      IS NULL OR cdn   LIKE '%' + @Cdn   + '%')
  ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, eventAt DESC
  OPTION (RECOMPILE);
END
