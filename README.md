# IT Dev Ops

Aplikasi internal sesuai `PRD.md`: NestJS 12 + React 19 + TypeScript, SQL Server pusat, registry JSON atomik, serta API equipment checks pada PC target. UI berbahasa Indonesia. Tidak ada mode demo atau data produksi buatan.

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
