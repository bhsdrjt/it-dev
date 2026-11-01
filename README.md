# IT Dev Ops

Aplikasi web internal untuk tim IT Dev Ops mengelola dan mengirim konfigurasi equipment check (flag `isGenerateCDN`) ke banyak PC target di jaringan lokal. Cocok untuk kantor/pusat logistik yang memiliki banyak PC lokasi dengan aplikasi `SNCAutoWBLocalAPI` berjalan di setiap PC.

## Apa itu aplikasi ini

- **Tujuan:** satu layar untuk melihat status seluruh PC target (online/offline, latency), mencari truck, mencari LocationID otomatis, dan mengirim perubahan `isGenerateCDN` ke PC target dalam beberapa klik — tanpa mengedit konfigurasi PC satu per satu secara manual.
- **Pengguna:** admin dan staf IT Dev Ops. Satu akun bersama (tidak ada multi-user/role saat ini).
- **Stack:** NestJS 12 + TypeScript (backend), React 19 + TypeScript (frontend SPA, di-bundle esbuild), mssql, axios, ping, jsonwebtoken. Node.js 22.13+.
- **Arsitektur:** browser SPA berkomunikasi ke backend NestJS di port 3000 via HTTP + JWT. Backend baca data referensi dari SQL Server pusat dan mengirim/ambil data konfigurasi langsung ke API lokal di tiap PC target.
- **Penyimpanan:** daftar PC target disimpan di file JSON registry (`data/apis.json`, dapat diubah via `APIS_FILE`) dengan tulisan atomik. Equipment dan lokasi dibaca dari SQL Server (`tabEquipment`, `tabLocation`). Konfigurasi check adalah sumber kebenaran di API tiap PC target, bukan di database pusat.
- **Tidak ada mode demo atau data produksi buatan.** Semua data berasal dari kredensial `.env`, database, dan PC target nyata.

### Alur kerja harian

1. Login dengan akun dari `.env` (token JWT berlaku 12 jam).
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
3. Salin `.env.example` menjadi `.env`, lalu isi `AUTH_USERNAME`, `AUTH_PASSWORD`, `DB_SERVER`, `DB_DATABASE`, `DB_USER`, dan `DB_PASSWORD`.
4. Buat `JWT_SECRET` acak dan masukkan hasilnya ke `.env`:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

5. Jalankan `npm start`, lalu buka `http://localhost:3000`. Perintah ini membangun backend/UI sebelum menjalankan server. Untuk menjalankan hasil build tanpa membangun ulang: `npm run serve`.

Server menolak startup bila variabel wajib kosong. Kredensial asli tidak disertakan. SQL Server tidak harus online saat startup; kegagalan query ditampilkan sebagai HTTP 503 dan koneksi dicoba kembali pada permintaan berikutnya.

## Keamanan deployment

- Gunakan HTTPS pada reverse proxy untuk akses browser. HTTP biasa tidak melindungi password maupun token dari penyadapan jaringan.
- Batasi akses server hanya untuk tim berwenang melalui firewall/VPN. Registry menentukan tujuan request HTTP backend; akun bersama dapat mengubah tujuan tersebut.
- API PC target memakai HTTP port 80 sesuai PRD. Batasi jalur jaringan antara server dan PC target; jangan mengeksposnya ke internet.
- Gunakan akun SQL Server dengan izin minimum, bukan administrator: SELECT untuk referensi dan pemeriksaan raw/final, EXECUTE untuk `dbo.usp_GetTruckTimelineByCoalDelivery`, `dbo.usp_SalinMuatan`, `dbo.usp_DataHilang`, `dbo.usp_DebugCTFinalDumpingTonnagebyID`, dan `dbo.sp_UpdateCTFinalDumpingTonnageIDManualByID` (termasuk procedure yang dipanggil di dalamnya melalui ownership chain), UPDATE pada `tabCTFinalLoadingTonnage` untuk aksi Lepas Relasi, SELECT dan UPDATE pada `tabCoalQualityAGM` untuk menu Coal Calory (UPDATE memicu trigger `trg_Sync_CoalQualityAGM_To_Enum_Update` ke `tabEnum`). Replay RawTerima menulis melalui procedure dan trigger; verifikasi izin sesuai ownership chain DB. Semua pengguna aplikasi yang login dapat menjalankan aksi tulis setelah konfirmasi; batasi akses aplikasi ke operator berwenang.
- `DB_ENCRYPT=true` dan `DB_TRUST_SERVER_CERTIFICATE=false` secara default. Pasang sertifikat SQL Server yang dipercaya. Menonaktifkan validasi sertifikat hanya untuk lingkungan pengujian terisolasi.
- Lindungi `.env` dan file registry dengan izin filesystem. Token browser disimpan di `sessionStorage`, berlaku 12 jam, dan dibuang saat logout/401. Logout hanya menghapus token lokal; rotasi `JWT_SECRET` membatalkan semua token.
- Login dibatasi 10 percobaan gagal per IP per 15 menit. Reverse proxy memerlukan pengaturan pembatasan sendiri; aplikasi tidak mempercayai header IP kiriman klien.

## Konfigurasi

Variabel PRD tersedia di `.env.example`. Tambahan koneksi SQL Server:

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `DB_PORT` | `1433` | Port SQL Server |
| `DB_ENCRYPT` | `true` | Enkripsi koneksi SQL Server |
| `DB_TRUST_SERVER_CERTIFICATE` | `false` | Abaikan validasi sertifikat hanya jika sengaja disetel `true` |

`APIS_FILE` relatif terhadap direktori kerja. File belum ada dibaca sebagai registry kosong; file dibuat ketika PC pertama disimpan. Format:

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

Registry dibaca ulang pada setiap operasi, mendukung UTF-8 BOM, dan menolak file rusak tanpa menimpanya. Penulisan menggunakan file sementara, `fsync`, dan rename dengan antrean dalam proses. **Jalankan satu proses server per file registry.** Jangan menulis file manual bersamaan dengan mutasi aplikasi; penyunting eksternal tidak mengikuti antrean. Backup file sebelum penyuntingan manual.

## Alur operator

1. Login menggunakan akun dari `.env`.
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

`npm test` membangun aplikasi, lalu memakai `node:test` dan `node:assert` tanpa framework tambahan. Cakupan: validasi input, normalisasi respons, BOM, write serentak, file rusak, ICMP/TCP, kegagalan request, pool reconnect, login/JWT 12 jam, endpoint tanpa token, CRUD HTTP, lookup berurutan/berhenti saat gagal, resolving nama, validasi upsert, dan DB 503. Tes memakai folder temporer dan stub jaringan/SQL, bukan database atau PC produksi.

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
src/registry.ts     registry JSON atomik dan serial
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
