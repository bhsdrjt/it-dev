# IT Dev Ops

Aplikasi web internal untuk tim IT Dev Ops mengelola dan mengirim konfigurasi equipment check (flag `isGenerateCDN`) ke banyak PC target di jaringan lokal. Cocok untuk kantor/pusat logistik yang memiliki banyak PC lokasi dengan aplikasi `SNCAutoWBLocalAPI` berjalan di setiap PC.

## Apa itu aplikasi ini

- **Tujuan:** satu layar untuk melihat status seluruh PC target (online/offline, latency), mencari truck, mencari LocationID otomatis, dan mengirim perubahan `isGenerateCDN` ke PC target dalam beberapa klik — tanpa mengedit konfigurasi PC satu per satu secara manual.
- **Pengguna:** akun individual dengan role dan permission per menu/aksi. Autentikasi disimpan di database `ITMonitor`, terpisah dari database produksi pada instance SQL Server yang sama.
- **Stack:** NestJS 12 + TypeScript (backend), React 19 + TypeScript (frontend SPA, di-bundle esbuild), mssql, axios, ping, jsonwebtoken. Node.js 22.13+.
- **Arsitektur:** browser SPA berkomunikasi ke backend NestJS di port 3000 via HTTP + JWT. Backend baca data referensi dari SQL Server pusat dan mengirim/ambil data konfigurasi langsung ke API lokal di tiap PC target.
- **Penyimpanan:** daftar PC target disimpan di `ITMonitor.dbo.ApiTargets`, memakai `Id INT IDENTITY(1,1)`, `LocationIDs` JSON berurutan, pool SQL auth dan transaksi atomik. Equipment dan lokasi dibaca dari SQL Server (`tabEquipment`, `tabLocation`). Konfigurasi check adalah sumber kebenaran di API tiap PC target, bukan di database pusat.
- **Tidak ada mode demo atau data produksi buatan.** Semua data berasal dari kredensial `.env`, database, dan PC target nyata.

### Alur kerja harian

1. Login dengan akun dari `ITMonitor` (token JWT berlaku 12 jam; status user dan izin diperiksa setiap request).
2. Tambah/edit PC target: isi nama PC, IPv4, dan pilih satu atau lebih lokasi DB.
3. Ping seluruh PC atau PC tertentu untuk melihat status online/offline dan latency.
4. Pilih truck, lalu cari LocationID otomatis: backend mencoba setiap lokasi terdaftar PC satu per satu. PC offline langsung dihentikan tanpa menunggu timeout.
5. Setel `isGenerateCDN`, konfirmasi, lalu kirim konfigurasi ke PC target. Muat ulang data PC setelah timeout pengiriman sebelum mencoba kembali.

### Kontrak API PC target

Backend memanggil tiap PC target lewat:

```text
GET  http://{ip}{API_BASE_PATH}/api/EquipmentChecks
GET  http://{ip}{API_BASE_PATH}/api/EquipmentChecks?equipmentID={id}&locationID={id}
POST http://{ip}{API_BASE_PATH}/api/EquipmentChecks/upsert
```

`API_BASE_PATH` default `/SNCAutoWBLocalAPI`. Lookup mencocokkan `equipmentID` dan `locationID` di sisi server. Payload upsert: `{ equipmentID, locationID, isGenerateCDN }`. Timeout upsert 10 detik.

Verifikasi kontrak terhadap satu PC uji sebelum pemakaian produksi. Jika API lokal berbeda, sesuaikan `src/pc.ts` dan `src/api.ts`.

## Menjalankan

1. Pasang Node.js **22.13+** (direkomendasikan Node.js 24) dan pastikan utilitas OS `ping` tersedia. Tanpa utilitas tersebut, monitoring memakai fallback TCP port 80.
2. Dari direktori proyek, jalankan `npm ci`.
3. Salin `.env.example` menjadi `.env`. Isi koneksi produksi `DB_SERVER`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, serta koneksi auth `AUTH_DB_DATABASE=ITMonitor`, `AUTH_DB_USER`, dan `AUTH_DB_PASSWORD`. Server, port, dan pengaturan TLS mengikuti koneksi produksi; gunakan login SQL terpisah dengan izin minimum. Database auth wajib berbeda dari database produksi.
4. Buat `JWT_SECRET` acak dan masukkan hasilnya ke `.env`:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

5. Selesaikan setup auth dan migrasi registry SQL di bawah sebelum menjalankan backend baru. Jalankan `npm start`, lalu buka `http://localhost:3000`. Perintah ini membangun backend/UI sebelum menjalankan server. Untuk menjalankan hasil build tanpa membangun ulang: `npm run serve`.

Server menolak startup bila variabel wajib kosong. Kredensial asli tidak disertakan. SQL Server tidak harus online saat startup; kegagalan query ditampilkan sebagai HTTP 503 dan koneksi dicoba kembali pada permintaan berikutnya. Jika `ITMonitor` tidak tersedia, login dan request terlindungi ditolak dengan 503; tidak ada fallback akun `.env`.

## Setup database autentikasi ITMonitor

1. DBA menjalankan `sql/itmonitor-auth.sql` melalui SSMS pada instance SQL Server yang sama. Script membuat `ITMonitor`, tabel `dbo.Auth*`, role, dan permission; tidak mengubah tabel produksi atau membuat password bawaan.
2. Buat login SQL khusus dan user di `ITMonitor`. Berikan SELECT/INSERT/UPDATE pada tabel auth yang diperlukan dan DELETE pada tabel relasi role. Untuk `dbo.UserAudit`, berikan SELECT dan INSERT; runtime tidak memerlukan UPDATE/DELETE audit. Jangan berikan `db_owner` atau `sysadmin`.
3. Isi `AUTH_DB_DATABASE=ITMonitor`, `AUTH_DB_USER`, dan `AUTH_DB_PASSWORD` di `.env`.
4. Untuk membuat admin pertama, set `BOOTSTRAP_ADMIN_USERNAME` dan `BOOTSTRAP_ADMIN_PASSWORD` sebagai environment sementara. Password minimal 12 karakter. Jalankan:

   ```powershell
   node --env-file-if-exists=.env sql/provision-admin.cjs
   ```

5. Hapus environment bootstrap setelah selesai. Script hanya membuat akun baru, tidak mereset akun existing. Jalankan `npm start`, lalu login dengan akun tersebut.

JWT tetap memakai bearer token existing. Izin dan status akun diperiksa ulang dari `ITMonitor` setiap request; perubahan password/role user mencabut token melalui versi autentikasi. Menu dan aksi dibatasi permission, termasuk perbaikan transaksi dan pengiriman konfigurasi PC. Login berhasil, pembacaan endpoint operasional (GET), ping, serta aksi tulis dicatat permanen di `dbo.UserAudit`. Pembacaan admin users/roles ikut dicatat; perubahan admin dan bootstrap diaudit dalam transaksi yang sama. Activity log browser tetap catatan sesi, bukan tampilan audit permanen.

Upgrade instalasi dengan `dbo.AuthAudit`: hentikan aplikasi, backup database, lalu DBA menjalankan `sql/user-audit.sql` sebelum menjalankan backend baru. Script mengganti nama tabel memakai `sp_rename`, mempertahankan data/ID/izin, memperbesar `Target` menjadi `nvarchar(max)`, menambahkan kolom lama yang belum ada, serta indeks actor/waktu dan operation ID. Jika kedua tabel sudah ada, migrasi berhenti tanpa menghapus data; rekonsiliasi manual diperlukan. Constraint outcome hanya ditambahkan jika data lama kompatibel. `sql/itmonitor-auth.sql` juga memuat migrasi yang sama untuk setup baru maupun rerun. Periksa kembali izin SELECT/INSERT runtime pada `dbo.UserAudit`. DBA harus memberi izin baca secara manual pada user SQL yang sama dengan `AUTH_DB_USER`: `USE ITMonitor; GRANT SELECT ON OBJECT::dbo.UserAudit TO [nama_user_runtime];` (ganti placeholder dengan user SQL aktual). Menu UserAudit dan `GET /auth/admin/audit` hanya menerima role `admin`, bukan sekadar permission `access.manage`. Endpoint ini read-only dan tidak menulis audit untuk pembacaan audit sendiri. Parameter: `limit` default 50 (1–100), `offset` 0–1000000, `user` username persis, `outcome`, `start` inklusif / `end` eksklusif dalam UTC `YYYY-MM-DDTHH:mm:ss`; urutan CreatedAt DESC lalu Id DESC. Pagination offset dapat bergeser jika audit baru masuk; muat ulang untuk data terbaru. Migrasi memerlukan akun DBA dengan izin DDL, bukan akun runtime. Server tidak otomatis membuat/mengubah database.

Audit menyimpan ActorUserId, action, target identifier/filter pencarian yang diizinkan, OperationId, outcome, dan waktu UTC. Request operasional mencatat `started` sebelum handler, lalu `succeeded`/`failed`; timeout/error server pada mutasi menjadi `unknown` karena perubahan mungkin sudah diterapkan. Jika audit awal gagal, handler diblokir; jika audit akhir gagal, baris `started` tetap tersedia dan respons 503 meminta pemeriksaan sebelum retry mutasi. Error read/ping menjadi `failed`; sukses ping berarti pemeriksaan selesai, bukan semua PC online. Password, token, header, body utuh, respons, dan SQL tidak disalin ke audit. Tidak mencatat polling `/auth/me`, login gagal, logout lokal, request yang ditolak guard, atau klik menu frontend.

Role awal: `admin`, `it_operator`, `transaction_operator`, `coal_editor`, dan `viewer`. Menu User dan akses tersedia untuk permission `access.manage`. Permission ekspor CSV mengatur tombol ekspor; user yang boleh membaca data tetap dapat menyalin data tersebut.

Database berbeda tidak mengisolasi resource atau downtime instance. Script setup belum otomatis dijalankan oleh aplikasi.

## Keamanan deployment

- Gunakan HTTPS pada reverse proxy untuk akses browser. HTTP biasa tidak melindungi password maupun token dari penyadapan jaringan.
- Batasi akses server hanya untuk tim berwenang melalui firewall/VPN. Registry menentukan tujuan request HTTP backend; akun bersama dapat mengubah tujuan tersebut.
- API PC target memakai HTTP port 80 sesuai PRD. Batasi jalur jaringan antara server dan PC target; jangan mengeksposnya ke internet.
- Gunakan akun SQL Server dengan izin minimum, bukan administrator: SELECT untuk referensi dan pemeriksaan raw/final, EXECUTE untuk `dbo.usp_GetTruckTimelineByCoalDelivery`, `dbo.usp_SalinMuatan`, `dbo.usp_DataHilang`, `dbo.usp_DebugCTFinalDumpingTonnagebyID`, dan `dbo.sp_UpdateCTFinalDumpingTonnageIDManualByID` (termasuk procedure yang dipanggil di dalamnya melalui ownership chain), UPDATE pada `tabCTFinalLoadingTonnage` untuk aksi Lepas Relasi, SELECT dan UPDATE pada `tabCoalQualityAGM` untuk menu Coal Calory (UPDATE memicu trigger `trg_Sync_CoalQualityAGM_To_Enum_Update` ke `tabEnum`). Replay RawTerima menulis melalui procedure dan trigger; verifikasi izin sesuai ownership chain DB. Aksi tulis membutuhkan permission spesifik selain konfirmasi. Akun SQL auth hanya mengakses database `ITMonitor`; jangan gunakan `sa` atau `db_owner` untuk runtime.
- `DB_ENCRYPT=true` dan `DB_TRUST_SERVER_CERTIFICATE=false` secara default. Pasang sertifikat SQL Server yang dipercaya. Menonaktifkan validasi sertifikat hanya untuk lingkungan pengujian terisolasi.
- Lindungi `.env` dan file registry dengan izin filesystem. Token browser tetap disimpan di `sessionStorage`, berlaku 12 jam, dan dibuang saat logout/401. Logout hanya menghapus token lokal; perubahan password/role user mencabut sesi melalui `TokenVersion`, dan rotasi `JWT_SECRET` membatalkan semua token. Migrasi cookie HttpOnly/CSRF belum termasuk perubahan ini; HTTPS dan mitigasi XSS tetap wajib.
- Login dibatasi 10 percobaan gagal per IP per 15 menit. Reverse proxy memerlukan pengaturan pembatasan sendiri; aplikasi tidak mempercayai header IP kiriman klien.

## Konfigurasi

Variabel PRD tersedia di `.env.example`. Tambahan koneksi SQL Server:

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `DB_PORT` | `1433` | Port SQL Server |
| `DB_ENCRYPT` | `true` | Enkripsi koneksi SQL Server |
| `DB_TRUST_SERVER_CERTIFICATE` | `false` | Abaikan validasi sertifikat hanya jika sengaja disetel `true` |

### Migrasi registry JSON ke ITMonitor

1. Hentikan backend lama dan backup JSON serta database. DBA menjalankan `sql/api-registry.sql` setelah setup auth. Script rerunnable, hanya membuat tabel yang belum ada; tidak dijalankan otomatis.
2. Berikan `SELECT, INSERT, UPDATE, DELETE` pada `dbo.ApiTargets` kepada user `AUTH_DB_USER`. DDL tetap hak DBA, bukan runtime. Jika tabel existing masih memakai UUID/string, gunakan `sql/api-registry-identity.sql` saat aplikasi dihentikan, bukan script pembuatan baru. Migrasi mempertahankan tabel lama sebagai `ApiTargets_LegacyIds` dan mapping ID pada `ApiTargetIdMap`. Berikan ulang izin CRUD pada tabel baru; cabut izin tulis runtime pada backup.
3. Jalankan `npm run build`, lalu impor eksplisit:

   ```powershell
   node --env-file-if-exists=.env sql/import-api-registry.cjs data/apis.json
   ```

4. Periksa hasil impor lalu jalankan backend baru. File sumber tidak diubah. Tidak ada impor saat startup atau fallback JSON ketika SQL gagal (HTTP 503).

`APIS_FILE` hanya alternatif path input CLI, relatif terhadap direktori kerja; bukan penyimpanan runtime. Input hilang/rusak ditolak, termasuk UTF-8 BOM yang dinormalisasi sebelum parsing. Seluruh input divalidasi sebelum koneksi/tulisan DB. Impor satu transaksi menghasilkan ID identity baru dan mempertahankan urutan lokasi. ID/lokasi duplikat dan nama/IP ambigu ditolak. Rerun mencocokkan nama/IP dan melewati baris persis sama; konflik membatalkan seluruh impor tanpa overwrite. ID lama dalam JSON tidak menjadi ID SQL. Daftar PC diurutkan berdasarkan nama lalu ID, tanpa kolom urutan. Impor tidak menghubungi DB produksi untuk validasi lokasi aktif; endpoint edit/tambah tetap memvalidasinya. Format:

```json
[
  {
    "id": "id-unik-stabil",
    "apiName": "Nama PC",
    "ipAPI": "192.0.2.10",
    "locationIDs": [7, 8]
  }
]
```

Alamat di atas hanya contoh dokumentasi, bukan PC bawaan. ID PC dibuat otomatis oleh aplikasi. IP hanya IPv4 literal, tanpa protokol/port/path. LocationID wajib integer nonnegatif dan lokasi aktif type 7. Daftar lokasi kosong diperbolehkan, tetapi PC tersebut belum dapat menerima konfigurasi.

Registry dibaca dari SQL pada setiap operasi. Mutasi memakai transaksi SERIALIZABLE dan lock tabel target untuk mencegah konflik lintas worker; daftar lokasi JSON diganti atomik. Penghapusan PC hanya menghapus baris registry, bukan data produksi atau log audit. Backup registry kini melalui backup ITMonitor.

## Alur operator

1. Login menggunakan akun individual dari `ITMonitor`.
2. Tambah PC, isi IPv4, lalu pilih satu atau beberapa lokasi DB.
3. Ping seluruh PC atau PC tertentu. Online ICMP tidak menjamin layanan API HTTP sehat; request data tetap dapat gagal.
4. Pilih PC dan truck. Lookup memeriksa TCP terlebih dahulu lalu lokasi PC berurutan. Error koneksi menghentikan loop.
5. Jika pasangan belum ditemukan, pilih lokasi terdaftar secara manual untuk konfigurasi baru. Atur `isGenerateCDN`, lalu konfirmasi pengiriman.
6. Klik **Muat data PC** untuk memeriksa konfigurasi langsung pada PC target. Setelah timeout pengiriman, muat ulang sebelum mencoba kembali: request mungkin sudah diterapkan oleh PC meskipun respons tidak diterima.

Log aktivitas hanya untuk sesi halaman aktif, bukan audit trail permanen. UI menggunakan status hasil ping terakhir, bukan koneksi real-time. Semua operasi API selain login memakai JWT; aset halaman login harus dapat diakses tanpa JWT.

## Menu aplikasi

Aplikasi menyediakan enam menu utama setelah login:

### Equipment checks (utama)

Kelola daftar PC target dan kirim konfigurasi equipment check (`isGenerateCDN`).
- Daftar PC dengan IP, status online/offline, latency, dan lokasi yang dilayani. Status adalah hasil pemeriksaan terakhir, bukan real-time.
- Tombol ping untuk semua PC atau satu PC. Ping berhasil tidak menjamin API HTTP sehat.
- Pilih truck → lookup LocationID otomatis di PC terpilih. PC offline langsung berhenti tanpa menunggu timeout.
- Jika konfigurasi belum ada, pilih LocationID dari lokasi terdaftar pada PC, atur Generate SK, lalu kirim konfigurasi.
- Setelah timeout pengiriman, muat ulang data PC sebelum mencoba kembali.

### Monitoring transaksi

Dasbor ringkasan temuan transaksi lintas SK dan truck.
- Filter rentang waktu (24 jam / 7 hari / bulan berjalan), truck, CoalDeliveryNumber, tingkat keparahan (kritis/warning), dan kategori (pasangan/lokasi/waktu).
- Kartu ringkasan, tren anomali per hari, kode temuan tersering, daftar temuan, dan truck paling terdampak.
- Setiap temuan bisa dibuka ke Analisa transaksi atau Timeline truck untuk verifikasi.
- **Status pratinjau:** tampilan masih berbentuk contoh dan belum terhubung ke database penuh. Gunakan untuk melihat bentuk tampilan, belum untuk pengambilan keputusan.

### Analisa transaksi

Menu inti untuk memeriksa satu CoalDeliveryNumber (SK) secara mendalam.
- Masukkan SK, tampilkan kartu Kirim (muat) dan Terima (timbang kosong), aktivitas reader/timbang, dan temuan berlevel info/warn.
- Aksi yang memerlukan konfirmasi: Salin Muatan, Generate SK Terima, Pasangkan Terima, Lepas Relasi, Cek relasi, Hapus, dan Masukkan ke Terima (RawTerima).
- Semua aksi mengubah data produksi. Setelah gagal atau timeout, cari ulang untuk melihat hasil sebenarnya; jangan mengulang otomatis.
- Aturan dan kode temuan lengkap ada di `docs/LOGIC_ANALISA_TRANSAKSI.md`.

### Timeline truck

Riwayat satu truck dalam rentang waktu tertentu.
- Pilih truck/EquipmentID, isi tanggal dan jam mulai serta selesai.
- Tab Kirim/Terima (transaksi final) atau Aktivitas truck (pembacaan reader dan timbang).
- Berguna untuk memeriksa apakah sebuah transaksi punya pasangan di luar SK yang sedang dicari.

### Coal calory

Kelola data kualitas batu bara (`tabCoalQualityAGM`).
- Lihat daftar kualitas beserta nilai calory, cari berdasarkan ID/CoalQualityID/nama.
- Edit nama dan nilai calory (boleh dikosongkan).
- Impor CSV dan Ekspor CSV untuk memperbarui banyak baris sekaligus.
- Hapus data (soft delete melalui `dtDeletedAt`, bukan permanen) dengan konfirmasi.
- Perubahan memengaruhi database pusat dan memicu sinkronisasi internal.

### Activity log

Catatan aktivitas selama sesi halaman terbuka di browser: waktu, tingkat (ok/error/info), pesan, dan catatan teknis. Ini bukan riwayat permanen dan hilang saat halaman ditutup/di-refresh.

## Kontrak API PC yang perlu diverifikasi

PRD tidak menjelaskan endpoint lookup khusus atau contoh respons aplikasi lama. Implementasi memakai:

```text
GET  http://{ip}{API_BASE_PATH}/api/EquipmentChecks
GET  http://{ip}{API_BASE_PATH}/api/EquipmentChecks?equipmentID={id}&locationID={id}
POST http://{ip}{API_BASE_PATH}/api/EquipmentChecks/upsert
```

Lookup mencocokkan `equipmentID` dan `locationID` di sisi server, sehingga tetap benar jika API mengabaikan filter dan mengembalikan seluruh koleksi. Respons harus array atau wrapper `data`, `items`, atau `result`; nama key tidak peka huruf besar/kecil. ID berupa integer atau string digit; flag mendukung boolean, 0/1, dan string `true`/`false`/`0`/`1`.

Payload upsert berisi `{ equipmentID, locationID, isGenerateCDN }` tanpa `apiId`. Respons HTTP 2xx dianggap sukses; error bisnis di dalam body 2xx belum memiliki kontrak. Redirect HTTP tidak diikuti. Timeout upsert 10 detik, lookup per lokasi mengikuti `LOOKUP_TIMEOUT_MS`.

**Verifikasi kontrak terhadap satu PC uji sebelum pemakaian produksi.** Jika API lokal memakai endpoint/payload lain, sesuaikan `src/pc.ts` dan metode lookup di `src/api.ts`. Tidak ada percobaan otomatis menulis ke PC produksi selama pembangunan.

## Pemeriksaan

```powershell
npm run check
npm test
npm audit
```

`npm test` membangun aplikasi, lalu memakai `node:test` dan `node:assert` tanpa framework tambahan. Cakupan: validasi input, normalisasi respons, BOM dan validasi impor, mapping SQL, rollback mutasi, konflik/rerun impor, ICMP/TCP, kegagalan request, pool reconnect, login/JWT 12 jam, endpoint tanpa token, CRUD HTTP, lookup berurutan/berhenti saat gagal, resolving nama, validasi upsert, dan DB 503. Tes memakai folder temporer dan stub jaringan/SQL, bukan database atau PC produksi.

Pemeriksaan browser lokal: login, registry kosong, error DB, dan dialog tambah/tutup PC. Integrasi SQL Server dan API PC nyata belum diverifikasi karena koneksi/kredensial belum diberikan.

Override `multer` dan `@azure/msal-node` di `package.json` menghindari versi transitif yang dilaporkan rentan oleh `npm audit`. Tinjau ulang override saat dependensi NestJS/mssql diperbarui.

## Dokumentasi pembelajaran

- [Penjelasan aplikasi untuk pengguna](docs/PENJELASAN_APLIKASI.md): apa aplikasi ini, fungsi tiap menu, alur kerja harian, arti status/pesan, dan batasan.
- [Panduan kode dan alur aplikasi](docs/PANDUAN_KODE.md): tanggung jawab file, urutan belajar, validasi, registry, DB, dan frontend.
- [Logic analisa transaksi](docs/LOGIC_ANALISA_TRANSAKSI.md): pasangan Kirim/Terima, batas ritase, aktivitas sebelum CDN, bukti fisik, kode temuan, dan batas kesimpulan.

## Struktur

```text
src/server.ts       bootstrap, konfigurasi, security headers, error filter
src/auth.ts         login, pembatasan percobaan, JWT guard
src/api.ts          endpoint dan orkestrasi validasi
src/registry.ts     registry SQL atomik dan impor eksplisit
src/db.ts           query referensi dan pool SQL Server
src/pc.ts           ICMP/TCP, HTTP PC, normalisasi respons
src/validation.ts   validasi input
web/App.tsx         UI login, dashboard equipment, dan editor PC
web/Transactions.tsx UI pencarian dan hasil transaksi
web/transaction-analysis.ts  aturan pasangan dan ritase
web/styles.css     tampilan native CSS
web/design-tokens.css token warna, radius, elevasi (single source of truth)
public/index.html  entry SPA; app.js/app.css dibangun esbuild
test/app.test.cjs   tes backend dan integrasi HTTP
test/transaction-analysis.test.cjs  tes aturan analisa dan input tidak dimutasi
test/workspace.test.cjs  tes interaksi dan layout browser
docs/              panduan kode dan logic analisa
```
