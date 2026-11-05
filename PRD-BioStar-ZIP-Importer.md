# PRD — BioStar ZIP Importer

| Item | Keputusan |
|---|---|
| Versi | 1.1 |
| Status | Rancangan; menunggu verifikasi schema dan pengujian |
| Bentuk | Modul pada aplikasi yang sudah ada |
| Frontend | React |
| Backend | NestJS |
| Database tujuan | SQL Server — BioStar |
| Input | ZIP dari BioStar ZIP Exporter |
| Cakupan | User, fingerprint, kartu CSN, relasi kartu |
| Revisi utama | Konflik USRID menggunakan suffix increment |
| Dokumen pasangan | PRD-BioStar-ZIP-Exporter.md |

## 1. Tujuan

Menyediakan menu import untuk memindahkan user dan credential dari paket exporter ke BioStar tujuan.

Hasil yang diharapkan:
- User, fingerprint, dan kartu terhubung dengan benar.
- Identity internal dibuat database tujuan.
- USRID yang tersedia dipertahankan; konflik menghasilkan suffix seperti 3-01.
- User lama tidak diubah atau digabung.
- Konflik kartu tidak menyebabkan perpindahan pemilik otomatis.
- Kegagalan tidak meninggalkan sebagian data.

**Penulisan langsung database BioStar dapat melewati aturan aplikasi. Produksi wajib didahului verifikasi schema, backup, dan pengujian pada salinan database serta perangkat. Sukses transaksi belum membuktikan credential berfungsi.**

## 2. Cakupan

### Termasuk

- Upload satu ZIP.
- Validasi arsip, manifest, CSV, dan referensi.
- Pemeriksaan schema/target dan mapping dependensi user.
- Pemeriksaan serta rename USRID yang bentrok.
- Preview, persetujuan perubahan ID, import transaksional.
- Progres, pembatalan, riwayat, dan laporan.
- Pencegahan konfirmasi/eksekusi paket berulang.

### Tidak termasuk

- Update, merge, atau overwrite user/credential lama.
- Pemindahan kartu otomatis.
- Pembuatan tipe kartu, layout, key, grup, atau permission otomatis.
- Credential selain fingerprint dan CSN.
- Konversi algoritma biometrik.
- Sinkronisasi perangkat otomatis.
- Perubahan schema BioStar.
- Tombol undo yang menghapus otomatis hasil committed.

## 3. Arsitektur

| Komponen | Tanggung jawab |
|---|---|
| React | Upload, preview, mapping, konfirmasi, progres, laporan |
| NestJS | Otorisasi, validasi, penjadwalan, import |
| Penyimpanan privat | ZIP dan file kerja |
| Database aplikasi | Status pekerjaan, rencana mapping, audit, hasil |
| SQL Server BioStar | Data user/credential tujuan |

- Browser tidak mengakses SQL Server.
- Target/koneksi dikonfigurasi backend; tidak menerima connection string bebas dari operator.
- Gunakan driver SQL Server dan fasilitas background job yang sudah tersedia.
- Status persisten dan pencegahan eksekusi ganda wajib; Redis/WebSocket tidak wajib.
- React menggunakan polling status.
- Backend mengakses BioStar lewat jaringan privat/VPN; jangan membuka SQL Server ke internet untuk fitur ini.

## 4. Menu React

Lokasi: **Integrasi BioStar → Import Data**.

### 4.1 Upload

Pilih satu ZIP, tampilkan nama/ukuran/batas upload/peringatan biometrik, lalu Upload dan Validasi. Frontend membantu validasi, tetapi backend memeriksa seluruh input.

### 4.2 Ringkasan

Tampilkan ID paket, versi format/exporter, waktu ekspor, sumber, filter, user, fingerprint, kartu unik, relasi, serta jumlah user tanpa credential. Tidak menampilkan template atau nomor kartu lengkap secara default.

### 4.3 Preview user

| Kolom | Isi |
|---|---|
| USRID sumber | Teks dari paket |
| Nama | Sesuai hak akses operator |
| USRID tujuan | ID rencana |
| Status | Tetap, Diganti, Diblokir |
| Alasan | Konflik, batas panjang, atau masalah lain |
| Fingerprint | Jumlah record |
| CSN | Jumlah relasi |

Contoh: sumber 3 menjadi 301 jika 3 telah digunakan; 10 tetap jika tersedia; 100 menjadi 2001 jika 100 dan 2001 digunakan.

### 4.4 Konfirmasi dan progres

Konfirmasi menampilkan target, ID paket, revisi preview, jumlah ID berubah/tetap, mapping dependensi, count credential, backup, serta maintenance. Operator harus menyetujui perubahan ID. Tombol Mulai Import aktif setelah semua pemeriksaan lulus.

Tampilkan tahap/count/status transaksi, tombol Batalkan bila masih memungkinkan, riwayat dan laporan sesuai hak akses. Mendukung keyboard, label aksesibel, serta indikator selain warna.

## 5. Kontrak ZIP

```text
manifest.json
users.csv
fingerprints.csv
cards.csv
user_cards.csv
```

Tepat lima file root. Tolak file hilang/tambahan, nama duplikat/ambigu, subfolder, path absolut, komponen .., symlink, entry bukan file, nested ZIP, ZIP terenkripsi, arsip rusak, atau kompresi tidak didukung. Jangan mengekstrak path bebas; proses hanya nama tetap yang diizinkan.

Batas yang wajib ditetapkan sebelum rilis:
- Upload terkompresi dan total byte dekompresi.
- Ukuran setiap entry dan manifest.
- Panjang field, ukuran template, jumlah record.
- Durasi pemrosesan dan kuota penyimpanan.

Terapkan pada byte aktual, bukan hanya metadata ZIP. Pelanggaran ditolak, bukan dipotong. Parser/dekompresi streaming agar paket tidak seluruhnya berada di memori.

## 6. Manifest dan CSV

Manifest wajib: format_version, schema_contract_id, package_id, exported_at_utc, exporter_version, source beserta semantik waktu, selection_summary, dependencies, files, totals. files memuat empat nama CSV tetap, ukuran, jumlah record tanpa header, dan SHA-256.

Hash diperiksa dari byte CSV setelah dekompresi sebelum parsing/normalisasi. Checksum bukan autentikasi pengirim. Manifest tidak boleh menentukan SQL, path, atau tabel arbitrer.

| File | Referensi |
|---|---|
| users.csv | source_usr_uid, USRID, profil sesuai kontrak |
| fingerprints.csv | source_usr_uid, FNGPIDX, DUR, TMPL0, TMPL1, CHS, LSTMOD |
| cards.csv | source_crd_uid, CRDTYPUID, CRDCSN, ASMUID, WGDFMUID, WGDFMTVER |
| user_cards.csv | source_usr_uid, source_crd_uid, IDX, ISSDDT, EXPDT, ISSDCNT, CRDMSK, PRDSTDT, PRDEDDT |

- UTF-8 tanpa BOM, delimiter koma, quoted fields, escaped quote, multiline, writer exporter CRLF.
- Header lengkap/urutan/tipe/nullability diikat schema_contract_id yang dikenal. Header hilang, berlebih, atau duplikat ditolak.
- Jangan Split(',') atau menghitung record dari jumlah newline.
- Setelah parsing CSV, nilai tepat `\N` adalah NULL.
- Nilai non-NULL mengikuti penggandaan backslash exporter. Periksa NULL dahulu, lalu decode pasangan backslash; escape invalid ditolak.
- String kosong berbeda dari NULL.
- Base64 harus valid secara ketat; jangan mengandalkan decoder permisif tanpa pemeriksaan.
- Tanggal ISO 8601 dengan presisi/semantik kontrak; angka invariant.
- USRID/CRDCSN selalu teks.
- Integer di luar presisi aman JavaScript tidak melalui Number; gunakan representasi lossless sesuai driver.
- Nilai tanggal berpresisi di atas milidetik tidak boleh kehilangan presisi akibat konversi JavaScript Date; gunakan jalur binding/konversi SQL tervalidasi yang mempertahankan presisi kontrak.
- Versi format/schema tidak dikenal ditolak.

Byte yang diimpor harus identik dengan yang divalidasi. Gunakan salinan kerja privat yang tidak berubah selama pekerjaan.

## 7. Validasi paket

### User

source_usr_uid unik; USRID valid; kolom memenuhi tipe/panjang/nullability; dependensi lengkap; akun/status di luar cakupan diblokir. Duplikasi USRID dalam paket menurut perbandingan tujuan tetap diblokir. Suffix menangani konflik terhadap tujuan, bukan memperbaiki paket ambigu.

### Fingerprint

Pemilik tersedia, Base64/ukuran valid, indeks/metadata sesuai kontrak, duplikasi tidak didukung diblokir.

### Kartu/relasi

- source_crd_uid unik; hanya CSN.
- CRDCSN tidak NULL/kosong/whitespace dan tidak diubah format.
- ASMUID, WGDFMUID, WGDFMTVER NULL untuk versi pertama.
- Referensi user/kartu tersedia; tidak ada relasi yatim/ambigu.
- Masa berlaku, mask, blacklist, serta status keamanan dapat dipertahankan.

Masalah pemblokir menghentikan seluruh paket. Jangan melewatkan record diam-diam. Jika diperlukan, operator memperbaiki atau mengekspor ulang.

## 8. Pemeriksaan tujuan

- Target sesuai konfigurasi dan izin.
- Versi/schema didukung: kolom, tipe, panjang, nullability, default, index, constraint, trigger.
- T_USR.USRUID, T_FNGPTMPL.FNGPUID, T_CRD.CRDUID merupakan identity.
- Grup/permission mapping valid.
- Collation/keunikan USRID diketahui.
- Konflik kartu diperiksa sesuai aturan aplikasi/schema, bukan tebakan global atau per tipe.

CSN tujuan: CRDTYPUID=0, NM=CSN, TYP=1, MD=C, CRDLAYUID=NULL. Operator telah mengonfirmasi ID 0; importer tetap memeriksa definisi. Jangan membuat/mengubah tipe kartu otomatis.

Pemeriksaan metadata SQL tidak menggantikan uji kompatibilitas BioStar.

## 9. Konflik USRID dan suffix

### 9.1 Kebijakan

Jika ID sumber tersedia, pertahankan. Jika bentrok di target, imputer menentukan angka pengganti yang tidak diawali nol, tidak mengandung huruf, dan tidak mengandung strip. Nomor positif terkecil tersedia, misalnya `3` → `301`, `1013`, `2003`. Jangan menggunakan `00` atau memutar ulang hitungan.

| Kondisi tujuan | Sumber | Hasil |
|---|---|---|
| 3 belum ada | 3 | 3 |
| 3 ada | 3 | 301 (atau angka pengganti lain yang bebas) |
| 3 dan 301 ada | 3 | 1013 (atau angka pengganti lain yang bebas) |

ID sumber yang sudah diubah tetap dianggap teks utuh. Tidak menghapus angka pengganti atau menebak ID dasar.

### 9.2 Reservasi paket

1. Validasi seluruh ID sumber.
2. Temukan ID sumber yang masih bebas di tujuan.
3. Cadangkan ID bebas untuk pemilik aslinya.
4. Alokasikan angka pengganti untuk ID bentrok dalam urutan source_usr_uid yang tetap sesuai tipe kontrak.
5. Cadangkan setiap kandidat agar tidak dipakai user lain.

### 9.3 Perbandingan dan batas

- Kesamaan mengikuti collation/semantik SQL Server tujuan, bukan hanya string JavaScript.
- Hasil preview disimpan sebagai rencana deterministik.
- Pastikan angka pengganti didukung BioStar serta perangkat, bukan hanya kolom SQL.
- Representasi harus disimpan tanpa kehilangan karakter.
- Jangan memotong ID sumber untuk memberi ruang angka pengganti.
- Jika tidak ada kandidat yang memenuhi batas, blokir paket.
- Metadata turunan seperti IDX* atau USRIDORD yang bergantung ID harus diperbarui sesuai aturan terverifikasi. Jangan menyalin nilai lama yang tidak cocok dengan ID baru.

## 10. Mapping credential

| Field | Fungsi |
|---|---|
| source_usr_uid | Referensi paket |
| source_usr_id | USRID asli |
| target_usr_id | Teks ID disetujui |
| target_usr_uid | Identity setelah INSERT |
| rename_reason | Alasan perubahan |

Fingerprint dan kartu dipetakan melalui source_usr_uid ke identity tujuan, bukan pencarian berdasarkan teks USRID asli setelah rename.

Urutan:
1. Insert user menggunakan target_usr_id tanpa USRUID sumber.
2. Ambil identity tujuan dan simpan mapping.
3. Insert fingerprint tanpa FNGPUID dengan target_usr_uid; Base64 menjadi Buffer dan parameter biner sesuai tipe.
4. Insert kartu tanpa CRDUID menggunakan tipe CSN tervalidasi dan CRDCSN asli.
5. Simpan source_crd_uid ke identity kartu tujuan.
6. Insert T_USRCRD dengan kedua identity dan metadata yang disetujui.

Gunakan parameter bertipe eksplisit. Identity diambil sesuai kontrak trigger, misalnya SCOPE_IDENTITY() dalam batch/scope yang sama. Variabel user/kartu dipisah. Dilarang MAX(id), @@IDENTITY, IDENTITY_INSERT ON, atau SQL hasil konkatenasi CSV.

## 11. Preview dan perubahan tujuan

Konfirmasi mengikat ID paket, target, mapping, serta revisi preview. Perubahan mapping/target membatalkan kesiapan sebelumnya.

Saat eksekusi, periksa kandidat dalam transaksi. Jika sudah dipakai proses lain:
1. Rollback.
2. Jangan memilih suffix baru diam-diam.
3. Buat preview baru.
4. Minta konfirmasi ulang.

Selama kandidat masih valid, gunakan rencana yang disetujui. Jika ID dasar kemudian bebas, jangan otomatis mengubah kembali pilihan yang disetujui.

## 12. Konflik kartu

Rename USRID tidak menyelesaikan konflik kartu. Jika kartu sudah ada di tujuan, blokir seluruh import: tidak memakai ulang, overwrite, atau memindahkan pemilik otomatis. Semantik keunikan harus diketahui dari schema dan aplikasi.

## 13. Alur import

1. Upload ZIP; backend menyimpan privat dan membuat pekerjaan.
2. Validasi format, checksum, CSV, relasi.
3. Periksa target dan dependensi.
4. Susun rencana USRID serta preview.
5. Operator menyetujui target, perubahan ID, dan mapping.
6. Jadwalkan background job persisten.
7. Worker memperoleh penguncian target.
8. Ulangi pemeriksaan yang dapat berubah.
9. Jalankan INSERT dalam satu transaksi.
10. Validasi count, mapping, data, dan biner.
11. Commit lalu simpan hasil/laporan.
12. Operator memverifikasi BioStar serta perangkat.

Request HTTP tidak menunggu seluruh transaksi panjang selesai. React melakukan polling pekerjaan.

## 14. Transaksi, konkurensi, dan pembatalan

- Satu transaksi untuk seluruh paket; koneksi/transaksi sama untuk semua command.
- SET XACT_ABORT ON serta exception handling dan rollback.
- Lindungi pemeriksaan ID/kartu dengan constraint/locking terverifikasi.
- Lock pekerjaan aplikasi saja tidak cukup jika BioStar/aplikasi lain masih menulis.
- Satu import aktif per target; lock berlaku lintas worker/instance.
- Jangan mengubah schema untuk menambah constraint tanpa persetujuan.
- Jika keunikan tidak dapat dijamin pada schema tersedia, belum siap produksi.
- Jangan commit per user atau retry tulis otomatis.

Sebelum commit, pembatalan meminta berhenti dan rollback. CANCELLED hanya setelah rollback terkonfirmasi. Saat commit berlangsung, jangan menjanjikan pembatalan masih bisa mengembalikan data.

Jika koneksi putus saat commit, hasil belum diketahui: jangan mengklaim sukses/rollback, jangan retry otomatis, wajib rekonsiliasi. Gap identity setelah rollback normal dan bukan bukti data tersimpan.

## 15. Pencegahan import berulang

Simpan di database aplikasi: package_id, hash ZIP, identitas isi paket, target, status, revisi/rencana mapping, hasil.

- Konfirmasi berulang pada pekerjaan sama tidak memulai transaksi baru.
- Paket committed pada target sama diblokir.
- package_id sama dengan isi berbeda ditolak.
- Isi paket sama dengan package_id berbeda ditandai duplikat dan diblokir.
- Identitas isi dihitung backend dengan algoritma versi tetap dari schema_contract_id dan hash CSV dalam urutan nama tetap, beserta metadata dependensi/semantik relevan yang dikanonisasi. Jangan memasukkan timestamp/ID paket yang berubah ke identitas isi.
- Hasil commit tidak pasti memblokir pengulangan sampai direkonsiliasi.

Dedup paket bukan dedup manusia. Ekspor baru dengan isi berbeda dapat memerlukan review operator. Fitur suffix tidak boleh diam-diam membuat user baru pada setiap pengiriman ulang paket sama.

## 16. Status pekerjaan

| Status | Arti |
|---|---|
| UPLOADED | Upload selesai |
| VALIDATING | Validasi paket/tujuan |
| REJECTED | Masalah pemblokir |
| READY | Preview siap |
| QUEUED | Sudah dikonfirmasi |
| IMPORTING | Transaksi berjalan |
| PREVIEW_STALE | Tujuan berubah, preview baru diperlukan |
| CANCELLING | Pembatalan/rollback berjalan |
| CANCELLED | Batal tanpa perubahan committed, terkonfirmasi |
| FAILED | Gagal tanpa perubahan atau rollback terkonfirmasi |
| COMMITTED | Commit berhasil |
| RECONCILIATION_REQUIRED | Hasil belum dapat dipastikan |

Status/audit ada di penyimpanan aplikasi. Jangan menambah tabel audit BioStar otomatis. Restart worker tidak boleh mengubah IMPORTING menjadi FAILED tanpa memastikan hasil transaksi. Commit database dan penyimpanan status aplikasi tidak diasumsikan atomik; ketidakpastian memerlukan rekonsiliasi.

## 17. API minimum

Prefix mengikuti konvensi aplikasi.

| Method | Endpoint konseptual | Fungsi |
|---|---|---|
| POST | /biostar/imports | Upload ZIP |
| GET | /biostar/imports | Riwayat |
| GET | /biostar/imports/:id | Status/ringkasan |
| GET | /biostar/imports/:id/preview | Preview rename berpaginasi |
| PUT | /biostar/imports/:id/mapping | Mapping dependensi |
| POST | /biostar/imports/:id/revalidate | Preview terbaru |
| POST | /biostar/imports/:id/confirm | Konfirmasi revisi preview |
| POST | /biostar/imports/:id/cancel | Permintaan pembatalan |
| GET | /biostar/imports/:id/report | Laporan |

Semua endpoint memeriksa izin pekerjaan/target, bukan login saja. Konfirmasi dan transisi status memakai kontrol konkurensi agar request ganda tidak memulai dua pekerjaan.

## 18. Keamanan

- Satu izin `biostar.import` untuk seluruh menu dan endpoint impor, termasuk upload, preview, konfirmasi, mulai, pembatalan, dan laporan. Konfirmasi/validasi pekerjaan tetap berlaku. Migrasi hanya memberi izin otomatis kepada role pemilik `biostar.import.start`; role lain ditetapkan admin.
- Pembatasan pengguna/organisasi dan target yang diizinkan.
- CSRF jika autentikasi cookie; rate limit upload/konfirmasi.
- Paket di luar direktori publik dengan nama internal buatan backend.
- HTTPS, SQL terenkripsi, sertifikat tervalidasi.
- Secret tidak dikirim ke React; akun SQL berizin minimum.
- Retensi dan pembersihan file ditetapkan; jangan hapus paket yang sedang digunakan worker.
- Tidak mencatat template, key, PIN, nomor kartu lengkap, atau password pada log.
- Mapping USRID dan nama user adalah data personal; preview/laporan mapping dibatasi, tidak dicetak ke log umum.
- Salinan kerja terlindungi terhadap perubahan setelah validasi.
- Penghapusan biasa bukan jaminan secure erase.

## 19. Validasi hasil dan laporan

Sebelum commit:
- Count user/fingerprint/kartu/relasi sesuai paket.
- USRID tujuan sama dengan rencana disetujui.
- Identity mapping benar dan tidak ada credential tertukar.
- CRDCSN utuh.
- Panjang dan SHA-256 biner cocok.
- Metadata keamanan/masa berlaku sesuai kontrak.

Laporan memuat pekerjaan/paket, operator/target, versi kontrak/importer, waktu, count, jumlah rename, mapping USRID berakses terbatas, status transaksi, dan peringatan. Tidak memuat template/secret.

Jika commit sukses tetapi laporan gagal disimpan, data tetap committed. Jangan melaporkan rollback. Ketidakpastian penyimpanan status harus direkonsiliasi sebelum retry.

Verifikasi operasional:
1. Buka user dengan USRID tujuan melalui BioStar.
2. Pastikan fingerprint dan kartu dikenali.
3. Sinkronkan melalui prosedur yang sesuai.
4. Uji fingerprint dan kartu fisik.
5. Pastikan suffix didukung perangkat.
6. Pastikan masa berlaku/nonaktif tidak menjadi lebih permisif.

COMMITTED tidak otomatis berarti pengujian perangkat lulus.

## 20. Kriteria penerimaan

| Pengujian | Hasil wajib |
|---|---|
| USRID bebas | Dipertahankan |
| 3 bentrok | 3-01 |
| 3-01 juga ada | 3-02 |
| Celah suffix | Nomor terkecil tersedia |
| Melewati 99 | 100, tidak 00 |
| Sumber sudah bersuffix | Teks utuh, misalnya 3-01-01 |
| Nol di depan | Tetap |
| ID sumber bebas dibutuhkan sebagai suffix | Dicadangkan untuk pemilik asli |
| Duplikasi paket menurut collation | Diblokir |
| Batas karakter/panjang suffix | Diblokir tanpa potong |
| Kandidat preview dipakai pihak lain | Rollback dan preview ulang |
| Metadata turunan ID belum diketahui | Blokir |
| User rename | Fingerprint/kartu tetap benar |
| Konflik kartu | Blokir walaupun rename tersedia |
| Paket committed diulang | Tidak membuat user baru |
| Konfirmasi ganda/two workers | Satu pekerjaan tulis per target |
| ZIP bomb/path traversal/duplikat entry | Ditolak sebelum import |
| CSV multiline/NULL/backslash/Unicode | Sesuai codec |
| Base64/hash/count rusak | Ditolak |
| Integer/tanggal berpresisi tinggi | Tidak kehilangan presisi |
| Error INSERT terakhir | Rollback seluruh paket |
| Putus koneksi saat commit | Rekonsiliasi, tanpa retry otomatis |
| Restart worker | Tidak menebak hasil transaksi |
| Commit sukses, laporan gagal | Data tetap dinyatakan committed jika diketahui |
| Akses tanpa izin | Ditolak |
| BioStar/perangkat | Credential dan USRID baru bekerja |

Minimal satu self-check runnable untuk allocator suffix/reservasi, batas tipe, codec, mapping, dan transisi status. Uji collation, locking, transaksi, dan kegagalan memakai SQL Server disposable dengan data sintetis. Uji interoperabilitas paket C# dan NestJS wajib.

## 21. Tahap implementasi dan prasyarat

| Tahap | Hasil |
|---|---|
| Verifikasi schema | Identity, metadata, collation, dependensi |
| Verifikasi USRID | Tanda '-', panjang, metadata turunan |
| Kontrak paket | Kompatibel dengan exporter |
| Validator/allocator | Paket valid dan preview deterministik |
| Uji satu user | Identity, fingerprint, CSN, suffix terbukti |
| React | Upload, preview, persetujuan, progres |
| Uji gagal | Rollback, lock, dedup, commit tidak pasti |
| Rilis internal | Backup, maintenance, retensi, rekonsiliasi |

Diperlukan: DDL sumber/tujuan, versi BioStar/SQL/firmware, aturan keunikan/karakter USRID, pembentukan metadata ketika ID berubah, mapping grup/permission, kebijakan blacklist, infrastruktur job/storage, batas upload/resource, prosedur backup/restore. Jangan menetapkan aturan dari contoh INSERT saja.

## 22. Keputusan final

React + NestJS menerima satu ZIP. USRID bentrok menghasilkan suffix increment minimal dua digit dengan preview dan persetujuan. User lama tidak diubah. Fingerprint dan kartu mengikuti identity tujuan melalui source_usr_uid/source_crd_uid. Konflik kartu memblokir. Satu transaksi, dedup paket, locking, dan penanganan commit tidak pasti wajib. Sukses database dibedakan dari credential yang tervalidasi pada BioStar/perangkat.
