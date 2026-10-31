# Panduan mempelajari kode

## Struktur dan tanggung jawab

```text
src/                         Backend NestJS
  server.ts                  Bootstrap, validasi environment, header keamanan, error HTTP
  auth.ts                    Login, pembatasan percobaan, penerbitan dan verifikasi JWT
  validation.ts              Validasi payload, query, ID, dan IPv4
  api.ts                     Controller: validasi dan orkestrasi service
  registry.ts                Penyimpanan daftar PC dalam JSON atomik
  db.ts                      Pool SQL Server, referensi, dan pemanggilan procedure timeline
  pc.ts                      ICMP/TCP, request API target, normalisasi equipment checks
web/                         Frontend React
  App.tsx                    Sesi login, dashboard equipment, editor PC, log sesi
  Transactions.tsx           Form pencarian dan penyajian transaksi/aktivitas/temuan
  transaction-analysis.ts    Logic analisa murni terhadap snapshot data
  styles.css                 CSS tampilan dan responsivitas
  design-tokens.css          token warna, radius, elevasi (single source of truth)
public/
  index.html                 Halaman masuk React
  app.js, app.css             Hasil build; jangan diedit manual
dist/                       Hasil kompilasi backend; jangan diedit manual
test/
  app.test.cjs               Validasi, registry, service, dan integrasi HTTP dengan stub
  transaction-analysis.test.cjs  Fixture aturan pasangan dan ritase
  workspace.test.cjs         Interaksi dan layout browser lokal
docs/
  PANDUAN_KODE.md             Peta aplikasi dan urutan belajar
  LOGIC_ANALISA_TRANSAKSI.md  Aturan analisa, batas bukti, dan daftar kode temuan
```

Folder tetap sederhana. Controller tidak mengurus penulisan file atau detail SQL; service tidak mengurus DOM. Logic analisa dipisahkan dari komponen agar dapat diuji tanpa browser/DB. Tidak ditambahkan framework, dependensi, atau lapisan abstraksi baru.

## Urutan belajar

1. Baca `README.md` untuk cara menjalankan dan batas keamanan deployment.
2. Baca `src/validation.ts` untuk melihat bagaimana `unknown` diperiksa sebelum digunakan.
3. Baca `src/api.ts` untuk memetakan endpoint ke service.
4. Ikuti `src/registry.ts`, `src/db.ts`, atau `src/pc.ts` sesuai tujuan operasi.
5. Baca `web/App.tsx` untuk alur pemilihan PC/truck dan pengiriman konfigurasi.
6. Baca `web/Transactions.tsx`, lalu [logic analisa transaksi](LOGIC_ANALISA_TRANSAKSI.md).
7. Jalankan tes sambil membaca fixture agar aturan bisnis dapat dilihat melalui contoh masukan dan keluaran.

## Backend

### Startup dan autentikasi

`validateEnvironment()` menolak konfigurasi wajib kosong, secret terlalu pendek, port/timeout tidak valid, dan base path yang tidak aman. Entry point memanggilnya sebelum `createApp()` dan `listen()`.

`createApp()` dipisahkan agar tes dapat membuat server lokal pada port sementara. Aplikasi membatasi JSON ke 32 KB, menetapkan header keamanan, memakai error filter, dan melayani aset `public/`. Aset login terbuka; endpoint bisnis dilindungi `JwtGuard`.

Login menghitung percobaan per IP dalam proses. Sepuluh percobaan yang belum direset oleh login sukses dibatasi selama jendela 15 menit. Map juga dibatasi untuk menghindari pertumbuhan tanpa batas. Kredensial dibandingkan melalui digest panjang tetap dan `timingSafeEqual`; digest ini bukan penyimpanan password DB. JWT memakai HS256, issuer/audience tetap, dan masa berlaku 12 jam.

### Registry PC

`list()` membaca ulang file setiap operasi, membersihkan UTF-8 BOM, memvalidasi struktur, dan menolak ID duplikat. File tidak ada berarti registry kosong; file rusak menjadi error, bukan dianggap kosong.

`mutate()` menjalankan read-modify-write dalam antrean Promise:

1. Baca registry dan jalankan perubahan pada array lokal.
2. Buat file sementara unik di direktori yang sama, dengan mode pembuatan eksklusif.
3. Tulis JSON, lakukan `sync()`, lalu tutup handle.
4. Rename file sementara menjadi registry aktif.
5. Jika gagal, coba bersihkan file sementara dan teruskan error ke pemanggil.

Promise antrean dipulihkan setelah gagal supaya operasi berikutnya tetap dapat berjalan. Pemanggil tetap menerima error task aslinya.

**Jalankan satu proses server per file registry.** Antrean ini tidak melindungi dari worker lain atau editor eksternal. Backup sebelum penyuntingan manual; jangan menyunting bersamaan dengan mutasi aplikasi.

### Database

`connect()` memakai kembali pool yang sehat. Request serentak menunggu `connecting` yang sama, bukan membuat pool masing-masing. Koneksi bersifat lazy sehingga UI tetap dapat startup saat DB offline.

`read()` menangani error DB. Pool yang putus dibuang agar request berikutnya dapat menyambung ulang. Kegagalan query tidak diputar ulang otomatis. `NotFoundException` timeline diteruskan sebagai 404; error lain diterjemahkan ke 503.

Query referensi memakai parameter SQL untuk ID. Timeline memakai parameter `VarChar(50)` dan stored procedure; detailnya ada dalam dokumen analisa. Aksi transaksi dan pembacaan timeline/history mengembalikan `queries` berisi statement yang benar-benar berjalan beserta nilai parameternya; UI menuliskannya ke Activity Log. Definisi SQL procedure tidak ada di repository ini. Pastikan akun DB memiliki izin minimum yang dibutuhkan untuk SELECT referensi dan EXECUTE procedure, tanpa memakai akun administrator.

### Koneksi PC dan equipment checks

`status()` mencoba ICMP, kemudian TCP port 80 jika ICMP gagal/tidak tersedia. Status online hanya hasil pemeriksaan saat itu, bukan bukti endpoint HTTP pasti sehat.

Lookup memeriksa TCP, memvalidasi equipment terhadap DB, lalu membaca lokasi PC sesuai urutan registry. Filter API target tetap dicocokkan ulang secara lokal karena API lama bisa mengabaikan query filter. Error koneksi menghentikan pencarian; tidak boleh dianggap konfigurasi belum ada.

Upsert memvalidasi equipment, lokasi aktif type 7, keanggotaan lokasi pada PC, dan boolean `isGenerateCDN`. Payload ke PC hanya `{ equipmentID, locationID, isGenerateCDN }`; `apiId` digunakan di backend untuk menentukan target.

Request HTTP tidak mengikuti redirect dan tidak menggunakan proxy environment. Respons equipment checks dibuka dari wrapper `data`/`items`/`result`, dengan kedalaman maksimal lima, lalu ID dan flag divalidasi.

**Timeout penulisan tidak membuktikan bahwa perubahan gagal diterapkan.** Muat ulang data target sebelum mengirim ulang; aplikasi tidak melakukan retry otomatis untuk POST.

## Frontend

### `App.tsx`

- `App` mengelola token `sessionStorage`, login/logout, dan fungsi request berautentikasi. HTTP 401 menghapus sesi lokal.
- `Dashboard` memuat PC/equipment/lokasi, mengelola pilihan, lookup, ping, pengiriman, navigasi, dan log.
- `PcEditor` memakai elemen native `<dialog>` untuk tambah/edit PC.
- `run()` memakai `Set` dalam ref sebagai kunci sinkron per aksi. `busy` hanya untuk tampilan; state React tidak cukup untuk mencegah dua klik sebelum render berikutnya.
- Effect lookup memiliki `AbortController`. Respons request lama tidak boleh menimpa pilihan truck/PC yang baru.
- `selectedKey` mencakup ID, IP, dan lokasi PC: edit PC yang sama dapat memicu lookup baru.
- Halaman equipment/transaksi disembunyikan memakai `hidden`, bukan dilepas dari React. Pilihan dan hasil pencarian tetap tersimpan ketika pindah menu.
- Log hanya berada dalam memori sesi halaman; bukan audit trail permanen.

### `Transactions.tsx`

Komponen ini menangani validasi form, request, pembatalan, pilihan tab, dan penyajian data. `pending` mencegah submit ganda dan menandai request aktif. Cleanup abort berlaku saat komponen dilepas; pindah menu dengan `hidden` tidak melepasnya.

Data dibagi untuk tampilan final, raw, dan aktivitas. Analisa tetap menerima snapshot lengkap agar CDN pembanding tidak hilang. `Set` aktivitas menggunakan identitas objek baris untuk memberi sorotan pada aktivitas sebelum CDN terbit dan aktivitas ritase tertutup; nilai CDN asli tidak diubah.

### `transaction-analysis.ts`

- Helper normalisasi menyiapkan pembandingan jenis transaksi, ID/CDN, truck, dan waktu.
- `analyzePairs()` membaca relasi tersimpan.
- `analyzeJourney()` membandingkan relasi tersebut dengan urutan reader/timbang dan batas ritase.
- `analyzeTransactions()` menggabungkan hasil tanpa melakukan I/O.

Komentar pada kode menjelaskan alasan aturan dan batasan, bukan mengulang arti setiap assignment. Penanda `ponytail:` menjelaskan batas penyederhanaan serta kapan mekanisme perlu ditingkatkan.

## Pemeriksaan perubahan

```powershell
npm run check
npm test
```

`check` memeriksa TypeScript backend/frontend. `test` membangun aplikasi lalu menjalankan tes Node; fixture jaringan/SQL menggantikan target nyata. Tes browser dapat dilewati oleh test runner jika dependensi browser lokal yang dibutuhkan tidak tersedia; periksa laporan, jangan hanya exit code.

Untuk mempelajari analisa saja tanpa build server:

```powershell
node --test test/transaction-analysis.test.cjs
```

Sesudah mengubah aturan bisnis, pertahankan tes input kosong/rusak, pembatasan waktu, salah pasangan, dan input tidak dimutasi. Validasi produksi terhadap stored procedure dan API PC tetap terpisah dari tes fixture.
