# Logic analisa transaksi

## Aksi kartu: Salin Muatan dan Hapus

Menu **Aksi** tersedia pada kartu Kirim/Terima final. Kirim menyediakan Salin Muatan, Generate SK Terima, dan Hapus; Terima hanya Hapus. Data dihapus dan operasi yang masih berjalan mengunci aksi. CDN Salin Muatan dan Generate SK Terima diambil dari kartu, read-only; truck sumber ditampilkan. Pencarian truck memakai `GET /equipments?activeOnly=true`, dengan `WHERE dtDeletedAt IS NULL`. Endpoint tanpa filter tetap melayani kebutuhan nama historis. Modal Salin Muatan tidak punya pilihan manual SK terima: setelah NoTruck tujuan diisi, sistem memeriksa kandidat Terima yang belum berpasangan. Ada kandidat → jalur `usp_SalinMuatanKeTerimaAda` (kandidat terdekat dipakai otomatis); tidak ada → jalur `usp_SalinMuatan` (Terima baru). Konfirmasi selalu menyebut jalur yang dipakai beserta ID Terima bila ada. Tombol nonaktif selama pemeriksaan belum selesai atau gagal, supaya jalur tidak salah.

- `POST /transactions/salin-muatan`: `{ coalDeliveryNumber, nextDT, confirmed: true }`, JWT, ASCII maksimal 20/8 karakter. Backend hanya menjalankan `dbo.usp_SalinMuatan` dengan `@CoalDeliveryNumberNya` VARCHAR(20) dan `@nextDT` VARCHAR(8); tidak ada query validasi atau INSERT/UPDATE Salin Muatan di aplikasi. Procedure menjadi sumber aturan: melepas relasi Kirim CDN sumber, memilih Kirim `TOP (1) dtLoaded DESC`, equipment tujuan, lalu timbang muat/kosong pertama yang belum dipakai.
- `GET /transactions/salin-muatan/candidates?coalDeliveryNumber=...&nextDT=...`: JWT, ASCII maksimal 20/8 karakter. Backend cari Kirim sumber `TOP (1) dtLoaded DESC` per SK, resolve truck penyalin lewat `tabEquipment.strTruckCN`, lalu ambil satu kandidat Terima (`TOP (1)`, `dtEmpty ASC`) milik truck itu dengan `dtEmpty >= dtLoaded` sumber, `dtEmpty <= DATEADD(DAY, 3, dtLoaded)` sumber, `dtDeletedAt IS NULL`, dan tidak ada `tabCTFinalLoadingTonnage` yang menunjuknya dengan `dtLoaded < DATEADD(DAY, 3, dtEmpty)` (dihitung berpasangan). Endpoint hanya membaca; hasil kosong berarti UI memakai jalur `usp_SalinMuatan`.
- `POST /transactions/salin-muatan/ke-terima-ada`: `{ coalDeliveryNumber, nextDT, ctFinalDumpingTonnageId, confirmed: true }`, JWT, ASCII maksimal 20/8 karakter dan ID integer positif. Backend hanya menjalankan `dbo.usp_SalinMuatanKeTerimaAda` dengan `@CoalDeliveryNumberNya` VARCHAR(20), `@NoTruck` VARCHAR(8), `@CTFinalDumpingTonnageID` INT. Procedure mengunci Kirim sumber dan baris Terima, lalu mengubah `EquipmentID`, `strEquipmentName`, `ContractorCompanyID`, `strContractorName`, dan `CTFinalDumpingTonnageID` Kirim, plus `dtUpdatedAt`/`UserName = 'By System SP'`. Sinkronisasi `CoalDeliveryNumber` Terima dilakukan trigger, bukan procedure. Kode error: `50010`/`50011` (Kirim sumber hilang atau `dtLoaded` kosong) → 404, `50012` (truck tidak ditemukan) → 404, `50013` (Terima tidak ditemukan) → 409, `50017` (jumlah baris update tidak sesuai) → 409, lainnya → 503 hasil belum pasti. Validasi jendela/pasangan tidak diulang di procedure karena sudah dilakukan saat pengambilan kandidat; sisa risiko adalah kandidat yang berubah antara pemeriksaan dan eksekusi.
- Procedure memakai transaksi internal dan melempar `50001` (final loading/`dtEmpty` tidak ditemukan), `50002` (equipment tidak ditemukan), `50003` (Kosong Terima tidak ditemukan), atau `50004` (Muat Terima tidak ditemukan). Backend memetakan kode tersebut ke HTTP 404/409; error lain atau timeout menjadi 503 dengan status hasil belum pasti. Trigger tetap dapat memengaruhi data terkait; periksa hasil sebelum mengulang, jangan retry otomatis.
- `POST /transactions/generate-sk-terima`: `{ coalDeliveryNumber, confirmed: true }`, JWT, ASCII maksimal 20 karakter. Backend menjalankan `dbo.usp_DataHilang` dengan `@CoalDeliveryNumberNya` VARCHAR(20). Procedure bertransaksi internal (`BEGIN TRAN`/`COMMIT`/`ROLLBACK`), melepas seluruh relasi Kirim CDN sumber, memilih Kirim TOP1 `dtLoaded DESC`, lalu timbang muat/kosong pertama pada truck sumber **tanpa filter `dtDeletedAt` dan tanpa guard Terima/relasi yang sudah ada** (berbeda dengan `usp_SalinMuatan`); insert lewat `usp_CTFinalDumpingTonnageInsert`. Backend mengunci sumber/kandidat, hanya menolak sumber tanpa waktu/truck atau kandidat kosong/invalid — aturan tambahan yang lebih ketat akan menolak perilaku procedure yang sah — lalu memverifikasi tepat satu Terima baru untuk CDN itu dengan truck dan `dtEmpty` kandidat sebelum commit. Karena aturan procedure longgar, hasil dapat menimpa kandidat timbang yang sudah dipakai; wajib konfirmasi + pemeriksaan hasil. Gagal/timeout → periksa hasil, jangan retry otomatis.
- `POST /transactions/delete`: `{ kind: 'Kirim' | 'Terima', tonnageId, confirmed: true }`, JWT, ID integer positif SQL int. Mapping hanya `tabCTFinalLoadingTonnage.CTFinalLoadingTonnageID` atau `tabCTFinalDumpingTonnage.CTFinalDumpingTonnageID`. Backend mengunci baris, menjalankan `SET dtDeletedAt = GETDATE()` untuk baris aktif, memverifikasi tepat satu perubahan dan status akhir, lalu commit. Ini soft delete; endpoint tidak secara eksplisit menghapus pasangan atau melepas relasi. Trigger tetap berlaku.

Konfirmasi diperlukan sebelum setiap mutasi. Hasil sukses memuat ulang timeline; kegagalan/hasil tidak pasti mengunci mutasi sampai pencarian ulang berhasil. Pengujian SQL menggunakan stub, browser menggunakan API fixture; tidak menjalankan mutasi produksi. Jalankan `npm test` (termasuk build/typecheck dan tes browser jika Chrome/Edge tersedia).

Dokumen ini menjelaskan perilaku kode di `web/transaction-analysis.ts`, bukan hasil investigasi database produksi. Analisa bersifat baca saja: temuan tidak mengubah CDN, referensi, atau transaksi. Aksi terpisah **Masukkan ke Terima** pada tabel TerimaRaw menulis ke DB setelah konfirmasi; lihat bagian 12.

## 1. Peta alur

1. Operator mengisi CoalDeliveryNumber pada `web/Transactions.tsx`. Dari Monitoring, pilihan Analisa transaksi otomatis mengisi SK dan memuat hasil, termasuk klik ulang SK yang sama. Masuk melalui sidebar tidak memicu pencarian otomatis. Target baru membatalkan request baca sebelumnya di browser dan mengabaikan respons lamanya; jika mutasi sedang berjalan, pencarian target menunggu mutasi selesai.
2. Browser memvalidasi teks, lalu mengirim `GET /transactions/timeline?coalDeliveryNumber=...` dengan JWT.
3. `ApiController.timeline()` memvalidasi kembali input: teks ASCII tanpa karakter kontrol, setelah trim maksimal 50 karakter. Validasi server tetap wajib meskipun browser sudah memvalidasi.
4. `DbService.truckTimeline()` mengikat parameter `CoalDeliveryNumber` sebagai `sql.VarChar(50)`, lalu menjalankan `dbo.usp_GetTruckTimelineByCoalDelivery`. Input tidak digabung ke SQL.
5. Result set pertama menjadi `transactions`, kedua menjadi `activities`. Result set yang tidak tersedia menjadi array kosong. Timeout query ini 60 detik; query referensi biasa memakai timeout 10 detik.
6. Browser menjalankan `analyzeTransactions()` terhadap snapshot tersebut. Tidak ada query tambahan untuk mencari pasangan yang hilang.
7. UI menampilkan pasangan seluruh Kirim pembanding, sedangkan rincian ritase (`journeys`) hanya untuk CDN pencarian. Tab Kirim / Terima memakai `groupTruckTransactions()` seperti Timeline truck: grup berdasarkan referensi tersimpan, dengan nomor ritase, SK, waktu mulai/selesai, status, dan catatan. Transaksi tanpa pasangan atau referensi ambigu tetap ditampilkan terpisah; SK sama tidak otomatis digabung. TerimaRaw tetap pada tab sendiri, seluruh aksi kartu dan penanda SK/dispatcher dipertahankan.

SQL error nomor `50001` dipetakan ke HTTP 404. Kegagalan DB lainnya menjadi HTTP 503 dengan pesan umum; detail teknis dicatat di server. Membatalkan request browser tidak menjamin query SQL ikut dibatalkan.

## 2. Sumber data dan batas bukti

Definisi procedure yang diberikan operator pada 5 November 2026 mengambil maksimal 10 gabungan Kirim/Terima, 10 TerimaRaw, dan 30 aktivitas termasuk New Assignment, masing-masing berurutan waktu paling awal. Jendela truck diambil dari Kirim terbaru untuk CDN: 2 jam sebelum `dtLoaded` sampai 144 jam setelah `dtLoaded`. `dtTimeCollected` TerimaRaw adalah `dtEmpty` ditambah 10 detik. Aturan SQL tidak diterapkan ulang oleh TypeScript; definisi yang terpasang di DB belum diverifikasi langsung.

UI Analisa transaksi menampilkan catatan cakupan di atas seluruh tab hasil. Jika jumlah gabungan Kirim/Terima mencapai atau melebihi 10, TerimaRaw 10, atau aktivitas 30, muncul peringatan **Data mungkin terpotong** beserta jumlah dan ambang yang tercapai. Hitungan memakai seluruh SK dalam respons, termasuk baris dihapus dan New Assignment; alias jenis transaksi dinormalisasi. Ini indikasi berdasarkan definisi operator, bukan konfirmasi data tambahan. Di bawah ambang maupun hasil kosong, catatan tetap menjelaskan bahwa jumlah baris dan jendela waktu membatasi hasil; data yang tidak muncul belum tentu tidak ada. Ambang ini tidak diterapkan pada Timeline truck yang memakai procedure berbeda. Jika server kelak menyediakan metadata cakupan, gunakan metadata tersebut menggantikan ambang UI.

Jumlah aktivitas dilaporkan dari respons aktual. Backend tidak menerapkan pemotongan tambahan. New Assignment ikut batas 30 aktivitas; penambahan assignment dapat mengurangi jumlah aktivitas timbang/reader yang terlihat.

**Tidak terlihat dalam hasil bukan berarti tidak ada di database.** Temuan adalah indikasi untuk diperiksa. Gangguan jaringan, kesalahan operator, atau kegagalan sinkronisasi tidak dapat disimpulkan tanpa log pendukung.

## 3. Fungsi dan keluaran

| Fungsi | Tanggung jawab |
| --- | --- |
| `transactionKind()` | Menyeragamkan alias jenis transaksi |
| `sameCdn()` | Membandingkan CDN string setelah trim dan uppercase |
| `activityStage()` | Memetakan label reader/timbang ke indeks tahap |
| `analyzePairs()` | Membaca pasangan berdasarkan referensi tersimpan dan memeriksa konsistensinya |
| `analyzeJourney()` | Menentukan batas satu ritase, menyaring aktivitas, memeriksa bukti fisik dan urutan |
| `analyzeTransactions()` | Mengorkestrasi seluruh pasangan/ritase dan memfilter keluaran CDN |

`pairs` berisi `{ loading, dumping, unpairedDumping?, findings }`. `dumping` hanya terisi jika referensi menunjuk tepat satu Terima pada snapshot. `unpairedDumping` hanya kandidat fisik untuk penanda pada kedua kartu, bukan pengganti relasi tersimpan.

`journeys` berisi `{ loading, start, end, counts, candidates, findings }`:

- `start` / `end`: string ISO atau `null` jika waktu tidak valid/tidak ditemukan. Awal yang valid sendiri belum menjamin jendela ritase valid.
- `counts`: jumlah per tahap, sesuai indeks tabel di bawah.
- `candidates`: baris aktivitas asli, indeks tahap atau `null`, timestamp numerik, dan alasan pemilihan (`basis`).
- `findings`: kode stabil, level `info` atau `warn`, dan penjelasan operator.

Semua array temuan dibuat baru setiap pemanggilan. `analyzeJourney()` dapat menambahkan temuan ke pasangan lain dalam keluaran jika referensinya ternyata menunjuk bukti fisik ritase ini. Karena itu semua ritase pembanding dianalisa **sebelum** daftar `journeys` difilter. Baris masukan tidak dimutasi; baris pada keluaran tetap merujuk objek masukan.

## 4. Normalisasi dan waktu

### Jenis transaksi

| Label masukan | Hasil |
| --- | --- |
| `Loading` | `Kirim` |
| `Dumping` | `Terima` |
| `RawDumping`, `DumpingRaw`, `RawTerima` | `TerimaRaw` |
| `Kirim`, `Terima`, `TerimaRaw`, label lain | Dipertahankan setelah trim |

Alias jenis transaksi peka kapitalisasi. `TerimaRaw` tidak pernah dijadikan pasangan final Kirim.

### Identitas

- `key()` menyetarakan angka dan representasi stringnya melalui `String`, trim, dan uppercase. `null`, `undefined`, serta string kosong menjadi `null`; string hanya spasi menjadi string kosong setelah trim, bukan `null`.
- ID tidak dinormalisasi secara numerik: `"020"` tidak otomatis sama dengan `20`.
- `sameCdn()` mensyaratkan kolom CDN bertipe string.
- `truckMatches()` mengutamakan `EquipmentID` jika kedua baris memilikinya. Jika tidak, pembandingan memakai `strEquipmentName` yang tersedia.
- Aktivitas reader dihubungkan lewat `strTruckCN` terhadap `strEquipmentName` Kirim, bukan melalui `EquipmentID` reader.

### Waktu

`timestamp()` menerima string waktu. Spasi pemisah tanggal/jam diganti `T`. Jika tidak ada akhiran `Z` atau offset `±HH:MM`, kode menambahkan `Z` agar perbandingan tidak bergantung zona waktu browser. Ini representasi teknis jam database, bukan pembuktian zona waktu operasional.

Waktu tidak valid menjadi `NaN`; kode tidak menggantinya dengan waktu sekarang. Jangkar Muat Kirim dibandingkan pada detik yang sama. Batas awal dan awal Kirim berikutnya dibulatkan turun ke detik. Pencocokan bukti fisik Terima memakai timestamp persis hingga presisi milidetik yang tersedia dari `Date.parse`.

## 5. Pasangan tersimpan

Relasi yang diperiksa:

```text
Kirim.RefDumpingTonnageID = Terima.CTFinalTonnageID
```

1. Ambil seluruh Kirim dan Terima; abaikan TerimaRaw untuk pairing.
2. Cari Terima dengan ID sama seperti referensi Kirim.
3. Pilih pasangan hanya jika ditemukan tepat satu baris. Tanpa referensi, tidak ditemukan, atau lebih dari satu hasil berarti pasangan belum terverifikasi.
4. Periksa CDN, EquipmentID jika tersedia di kedua sisi, waktu, dan tanda penghapusan pasangan.
5. Periksa apakah Terima yang sama ditunjuk oleh Kirim lain.
6. Jika CDN pasangan berbeda, cari Kirim sebelumnya pada truck yang sama untuk menjelaskan apakah CDN tersebut milik ritase sebelumnya atau ritase lebih awal yang terlihat.

Terima dengan CDN sama tetapi ID tidak sesuai referensi hanya menjadi catatan kandidat. Kode tidak mengganti relasi tersimpan dengan tebakan tersebut.

## 6. Tahap aktivitas

| Indeks | Tahap | Label yang dikenali setelah normalisasi | Aturan hitungan |
| --- | --- | --- | --- |
| 0 | Kosong Kirim | `kirim kosong`, `kosong kirim` | Diharapkan 1 |
| 1 | MT | `mt`, `mobiletower`, `mobile tower`; reader tertentu di bawah | Opsional, boleh berulang |
| 2 | Muat Kirim | `kirim muat`, `muat kirim` | Diharapkan 1 |
| 3 | Tollgate | `tol gate`, `toll gate`, `tollgate`, `tolgate` | Diharapkan 1–2 |
| 4 | Muat Terima | `terima muat`, `muat terima` | Diharapkan 1 |
| 5 | Kosong Terima | `terima kosong`, `kosong terima` | Diharapkan 1 |

Label `trans` diubah ke lowercase; spasi, underscore, dan tanda hubung diseragamkan menjadi spasi. `Net Reader` atau `Check Point` hanya menjadi MT jika `ReaderLocationName` cocok pola MT/mobile tower. Reader lain tetap ditampilkan sebagai tahap tidak dikenal, bukan otomatis MT.

MT mengenali asal batu di front loading. Tidak ada MT bukan anomali: operator dapat memilih asal batu manual. Analisa tidak membuktikan bahwa pemilihan manual benar-benar dilakukan.

### New Assignment

`trans = 'New Assignment'` pada result set kedua tampil di **Aktivitas truck** dengan ikon/warna tersendiri, waktu perubahan `dtTimeCollected`, truck `strTruckCN`, lokasi muat dan bongkar. Bukan transaksi final, bukan tahap timbang wajib, bukan pemicu batas ritase, dan tidak ditandai sebagai aktivitas tidak dikenal. Catatan di dalam ritase tetap ditampilkan menurut waktu tanpa mengubah hitungan tahap/pairing. Catatan di luar kelompok ritase tampil terpisah sebagai perubahan assignment, bukan ritase tidak lengkap. Waktu invalid tetap ditampilkan dengan catatan.

SQL terbaru menyelaraskan posisi UNION assignment: `LoadingLocationName = ll.strLocationName` (lokasi muat), `DumpingLocationName = ld.strLocationName` (lokasi bongkar), dan `ReaderLocationName = NULL`. Kartu aktivitas dan bukti pada Analisa anomali memakai nama kolom tersebut langsung, tanpa mapping pergeseran. Detail seluruh kolom mempertahankan respons asli.

Catatan ini menunjukkan nilai assignment tercatat, bukan perbandingan assignment lama/baru atau bukti perubahan SK. Procedure tidak menyediakan nilai sebelumnya; UI tidak menebaknya.

## 7. Batas ritase dan aktivitas sebelum CDN

### Menentukan awal

1. Ambil aktivitas bertimestamp valid pada truck Kirim yang sama, urutkan menurut `dtTimeCollected`.
2. Cari jangkar: Muat Kirim dengan CDN sama dan waktu pada detik yang sama dengan `Kirim.dtLoaded`.
3. Dari aktivitas sebelum jangkar, ambil timbang terakhir di antara tahap 0, 2, 4, dan 5. MT/reader tidak memutus urutan timbang.
4. Jika timbang terakhir adalah Kosong Kirim dengan CDN kosong atau sama, jadikan aktivitas tersebut awal ritase. MT di antara Kosong Kirim dan jangkar dapat diberi basis `Urutan sebelum CDN terbit`.
5. Jika awal tersebut tidak ditemukan, gunakan `Kirim.dtEmpty`. Bila ada timbang sebelumnya, awal paling cepat adalah nilai maksimum `dtEmpty` dan waktu timbang sebelumnya ditambah 1 detik.

CDN biasanya terbit saat Muat Kirim. Mengikutkan Kosong Kirim/MT sebelumnya tidak mengisi atau mengubah nilai CDN asli.

### Menentukan batas berikutnya dan penutup

- Cari Kirim lain pada truck sama dengan `dtEmpty` setelah awal ritase; ambil yang paling awal dan bulatkan turun ke detik.
- Cari aktivitas setelah `dtLoaded` yang berupa Kosong Kirim, atau Muat Kirim dengan CDN terisi dan berbeda.
- `cutoff` adalah waktu paling awal dari dua batas tersebut. Jika keduanya tidak terlihat, nilainya `Infinity`.
- Penutup adalah Kosong Terima pertama pada/selepas `dtLoaded`, sebelum `cutoff`, dengan CDN kosong atau sama.
- Kosong Terima penutup **ikut dihitung**; semua aktivitas setelahnya tidak ikut, walaupun CDN sama. Aktivitas tepat pada `cutoff` juga tidak ikut.

Jendela valid jika awal dan `dtLoaded` valid, `dtLoaded >= start`, serta `dtLoaded < cutoff`. Jendela tidak valid menghasilkan `invalid-window`; kandidat dan hitungan tahap tetap kosong/nol.

### Penyaringan kandidat

Untuk setiap aktivitas pada snapshot:

1. Tolak jika nama truck kedua sisi tersedia tetapi berbeda.
2. Abaikan waktu tidak valid.
3. Tolak aktivitas di luar batas awal, penutup, atau cutoff.
4. Tolak CDN terisi yang berbeda.
5. Jika CDN tidak cocok eksplisit, identitas nama truck harus cocok menurut `key()`.
6. Simpan baris asli beserta `basis`, lalu urutkan kandidat menurut waktu.

Prioritas `basis`: `CDN eksplisit`, lalu `Urutan sebelum CDN terbit`, lalu `Urutan ritase hingga Terima Kosong`, atau `Kandidat ritase belum selesai` bila penutup belum ada.

Batasan data kosong: jika nama truck Kirim maupun aktivitas sama-sama tidak ada, pembandingan `key()` keduanya dapat sama-sama `null`. Jangan menafsirkan ini sebagai identitas truck yang terverifikasi; kualitas kolom identitas tetap harus diperiksa.

`excluded-events` bukan total semua aktivitas di luar jendela. Aktivitas yang ditolak hanya karena waktu di luar jendela dilewati tanpa menambah penghitung tersebut. `undated-events` menghitung waktu tidak valid setelah penyaringan awal truck.

## 8. Pemeriksaan pasangan fisik

Pemeriksaan ini dijalankan dalam jendela valid dan membutuhkan **Kosong Terima penutup**; Kosong Kirim dan jangkar Muat Kirim tidak wajib karena aktivitas Kirim dapat tidak tersedia. Muat Terima tetap wajib berada tidak lebih awal dari `dtLoaded` Kirim. Jika aktivitas Kirim hilang, halaman tetap menampilkan `missing-{indeks}` terkait.

Kandidat Terima fisik harus memenuhi semuanya:

- Truck cocok menurut `truckMatches()`.
- `dtDeletedAt` tidak bernilai truthy.
- `Terima.dtLoaded` cocok dengan waktu salah satu kandidat Muat Terima: sama persis, atau pada detik yang sama jika nilai final berpresisi `.000` (milidetik nol).
- `Terima.dtEmpty` cocok dengan waktu Kosong Terima penutup dengan aturan presisi yang sama.

Final dengan milidetik bukan nol tetap harus sama persis sampai milidetik; pencocokan detik hanya untuk `.000`. Lebih dari satu kandidat cocok menghasilkan `ambiguous-physical-pair`.

Jika tepat satu kandidat fisik cocok, CDN sama, referensi Kirim kosong, Kirim tidak dihapus, tidak ada Kirim lain pada snapshot yang menunjuk Terima tersebut, dan hanya satu Kirim aktif dengan CDN/truck itu, muncul `not-auto-paired`: **data tidak berpasangan otomatis**. Note tampil pada kartu Kirim dan Terima di timeline serta temuan pasangan/ritase. Tidak bergantung pada batas 48 jam dan tidak menyimpulkan penyebab historis. `dumping` tetap kosong; kandidat dicatat sebagai `unpairedDumping`.

Di luar kondisi tersebut, jika tepat satu kandidat cocok tetapi berbeda dari pasangan tersimpan, atau CDN-nya berbeda, muncul `physical-pair-mismatch`. Kirim lain yang menunjuk Terima tersebut mendapat `dumping-belongs-other-trip`. Jika lebih dari satu kandidat cocok, muncul `ambiguous-physical-pair`; tidak ada pemilihan otomatis.

Jika pasangan tersimpan memiliki waktu kosong berbeda dari penutup ritase, muncul `linked-dumping-close-mismatch`.

Jika penutup terlihat tetapi pasangan tersimpan dan kandidat fisik tidak ditemukan, analisa membedakan Terima dengan CDN/truck sama yang belum terhubung dari Terima yang belum terlihat sama sekali. Keduanya memerlukan pemeriksaan DB, bukan perbaikan otomatis.

### Contoh pembelajaran

```text
Kirim A: CDN LAMA, referensi Terima #20
Kirim B: CDN BARU, referensi kosong
Terima #20: CDN LAMA, truck sama
Aktivitas ritase B: Muat Terima 12:00; Kosong Terima 12:30
Terima #20: dtLoaded 12:00; dtEmpty 12:30
```

Jika awal/jangkar/penutup ritase B terverifikasi pada snapshot, waktu fisik menunjuk Terima #20 sebagai kandidat untuk B. B mendapat `physical-pair-mismatch`; A mendapat `dumping-belongs-other-trip`. `pairs[B].dumping` tetap kosong karena referensi tersimpan B kosong. Contoh ini menunjukkan dugaan salah taut, bukan bukti penyebabnya.

### Penanda dispatcher

Kirim/Terima final dengan `dtTimeCollected` valid dan milidetik eksplisit `.000` atau `,000` mendapat penanda **created by dispatcher**. Mendukung format SQL/ISO dan offset waktu. Waktu kosong, invalid, tanpa pecahan detik, atau milidetik bukan 000 tidak ditandai. TerimaRaw dan aktivitas reader tidak ditandai. Ini aturan tampilan berdasarkan presisi waktu sesuai permintaan operator, bukan bukti audit identitas pembuat; nilai sumber tidak diubah.

## 9. Kelengkapan, duplikasi, urutan

- Tahap wajib yang tidak terlihat menghasilkan `missing-{indeks}` berlevel `info`.
- MT tidak terlihat menghasilkan `optional-mt`, bukan `missing-1`.
- Jumlah melebihi batas tahap menghasilkan `duplicate-{indeks}` berlevel `warn`.
- Tahap menurun setelah tahap tertinggi yang telah terlihat, dengan waktu lebih besar daripada saat tahap tertinggi itu pertama dicapai, menghasilkan `out-of-order`. Waktu identik tidak dipaksa memiliki urutan.
- Jika semua tahap wajib terlihat dan tidak ada warning pada **temuan ritase**, muncul `sequence-observed`. Ini bukan jaminan pasangan tersimpan benar; warning pada `pair.findings` tetap perlu dibaca.
- Penutup belum terlihat menghasilkan `open-window`. Jika batas ritase berikutnya terlihat atau Muat Kirim muncul lebih dari sekali, tambahkan `dispatch-before-receipt`.

## 10. Daftar kode temuan

| Kode | Level | Makna |
| --- | --- | --- |
| `no-reference` | warn | Kirim tidak menunjuk Terima |
| `unresolved-reference` | info | ID yang ditunjuk tidak terlihat |
| `ambiguous-reference` | warn | ID Terima muncul lebih dari sekali |
| `missing-cdn` | info | CDN salah satu sisi kosong |
| `cdn-mismatch` | warn | CDN pasangan berbeda |
| `truck-mismatch` | warn | EquipmentID kedua sisi berbeda |
| `dumping-before-loading` | warn | Waktu Terima mendahului muat Kirim |
| `dumping-time-reversed` | warn | Waktu kosong Terima mendahului waktu muatnya |
| `deleted-dumping` | warn | Pasangan Terima ditandai dihapus |
| `shared-reference` | warn | Beberapa Kirim menunjuk Terima sama |
| `cdn-only-candidate` | info | CDN sama tanpa relasi ID yang terverifikasi |
| `invalid-window` | info | Batas ritase tidak dapat dipakai |
| `pre-cdn-sequence` | info | Kosong Kirim sebelum penerbitan CDN teridentifikasi |
| `trip-closed` | info | Kosong Terima penutup terlihat |
| `open-window` | info | Penutup belum terlihat |
| `dispatch-before-receipt` | warn | Kirim berikut/berulang terlihat sebelum penutup terverifikasi |
| `not-auto-paired` | warn | Kandidat fisik/CDN/truck cocok, referensi Kirim kosong; data tidak berpasangan otomatis |
| `physical-pair-mismatch` | warn | Bukti fisik tidak cocok dengan pasangan/CDN tersimpan |
| `dumping-belongs-other-trip` | warn | Referensi menunjuk Terima yang cocok dengan ritase lain |
| `ambiguous-physical-pair` | warn | Beberapa Terima cocok dengan bukti waktu fisik |
| `linked-dumping-close-mismatch` | warn | Waktu pasangan berbeda dari penutup ritase |
| `receipt-without-linked-dumping` | warn | Penutup dan Terima CDN/truck sama terlihat, relasi belum terverifikasi |
| `receipt-without-dumping` | warn | Penutup terlihat tetapi Terima belum terlihat |
| `inferred-events` | info | Aktivitas tanpa CDN dikelompokkan menurut urutan ritase tertutup |
| `excluded-events` | info | Sebagian aktivitas ditolak menurut identitas |
| `undated-events` | info | Sebagian aktivitas tanpa waktu valid |
| `unknown-events` | info | Label aktivitas belum dipetakan |
| `optional-mt` | info | MT opsional tidak terlihat |
| `missing-{indeks}` | info | Tahap wajib belum terlihat |
| `duplicate-{indeks}` | warn | Jumlah pembacaan melebihi batas |
| `out-of-order` | warn | Urutan tahap mundur pada waktu berikutnya |
| `sequence-observed` | info | Tahap wajib terlihat tanpa warning ritase |

## 11. Pengujian dan perubahan aturan

Jalankan dari direktori proyek:

```powershell
node --test test/transaction-analysis.test.cjs
npm run check
npm test
```

Tes analisa menggunakan fixture lokal, `node:test`, `node:assert`, dan transpiler esbuild yang sudah terpasang. Tidak perlu koneksi DB. Cakupan mencakup relasi ID, penolakan TerimaRaw, CDN ritase sebelumnya, MT opsional, batas ritase, duplikasi, salah pasangan fisik, waktu kosong, serta input yang tidak boleh dimutasi.

Saat aturan berubah, ubah fixture dan ekspektasi terkait terlebih dahulu, sesuaikan fungsi analisa, lalu perbarui dokumen ini dan penjelasan UI. Jangan mengganti relasi otomatis hanya karena sebuah heuristic menemukan kandidat.

## 12. Memproses RawTerima ke Terima

Tombol **Masukkan ke Terima** memakai `CTFinalTonnageID` baris TerimaRaw (alias `CTFinalDumpingTonnageRawID`), bukan CDN. Aksi memakai `POST /transactions/raw-terima` dengan JWT, body `{ rawTonnageId, confirmed: true }`, lalu memanggil `dbo.usp_DebugCTFinalDumpingTonnagebyID` dengan `@id` bertipe SQL `Int`.

1. Operator mengonfirmasi ID raw, CDN sebagai keterangan, dan efek procedure: menambah Terima, memperbarui relasi Kirim, serta kemungkinan menandai transaksi lama dihapus sesuai aturan timbang ulang. Tombol ini tidak menghapus raw.
2. Backend memvalidasi ID integer positif dalam rentang SQL int dan konfirmasi. Dalam transaksi DB, raw dikunci berdasarkan `CTFinalDumpingTonnageRawID = @id` memakai `UPDLOCK, HOLDLOCK`. Raw harus tepat satu, tidak dihapus, serta memiliki EquipmentID dan dtTimeCollected. Beberapa raw dengan CDN sama diperbolehkan karena pemilihan berdasarkan ID; CDN kosong juga tidak menghalangi tombol.
3. Backend menolak jika final untuk EquipmentID dan dtTimeCollected raw sudah ada, termasuk final yang dihapus. Waktu diperiksa langsung dari DB, bukan waktu TerimaRaw pada timeline yang ditambah 10 detik.
4. Backend menjalankan `dbo.usp_DebugCTFinalDumpingTonnagebyID` dengan parameter `@id` dari baris raw yang dipilih. Backend memeriksa tepat satu final aktif untuk truck/waktu raw sebelum commit; kegagalan memicu upaya rollback. Procedure dan trigger tetap menentukan efek bisnis, bukan analisa frontend.
5. Setelah berhasil, UI memuat ulang CDN pencarian. Request ganda dicegah saat proses. Setelah error atau hasil tidak pasti, tombol terkunci sampai pencarian ulang berhasil. Tidak ada retry otomatis; kegagalan koneksi saat commit tidak membuktikan perubahan belum tersimpan.

Pengujian replay memakai SQL stub dan browser dengan API fixture: validasi, JWT, pembatalan konfirmasi, ID raw per baris meskipun CDN sama, request ganda, rollback, hasil tidak pasti, dan refresh. Procedure mutasi tidak dijalankan pada DB produksi selama pengembangan fitur ini.

## 13. Memasangkan Kirim dengan Terima

Tombol **Pasangkan Terima** tampil pada Kirim tanpa `RefDumpingTonnageID`, di timeline dan Analisa anomali. Kirim dihapus tidak dapat diproses. Endpoint `POST /transactions/relations/pair` memakai JWT dan body `{ loadingTonnageId, confirmed: true }`; ID wajib integer positif dalam rentang SQL int.

Backend menjalankan `dbo.sp_UpdateCTFinalDumpingTonnageIDManualByID` dengan `@CTFinalLoadingTonnageID` dari `CTFinalTonnageID` Kirim. Definisi procedure memilih satu Terima aktif pada EquipmentID sama, `dtEmpty >= dtLoaded` Kirim, diurutkan `dtEmpty ASC` (waktu kosong timbang, bukan waktu pencatatan). **Tidak dibatasi CDN, ritase berikutnya, atau posisi kartu di web.** Konfirmasi menjelaskan aturan ini dan efek trigger yang dapat memperbarui CDN, kualitas batu, serta data terkait Terima.

Dalam transaksi DB, backend mengunci Kirim/kandidat, menolak referensi yang sudah terisi, data dihapus/tidak lengkap, kandidat kosong, dua kandidat pertama dengan waktu sama, serta kandidat yang sudah ditunjuk Kirim aktif lain (`dtDeletedAt IS NULL`). Referensi milik Kirim yang sudah dihapus tidak menghalangi pairing dan tidak dilepas otomatis. Tidak melompati kandidat pertama yang dipakai untuk memilih kandidat berikutnya. Hasil referensi setelah procedure harus sama dengan kandidat sebelum commit. Error memicu upaya rollback; hasil tidak pasti harus diperiksa lewat pencarian ulang, bukan retry otomatis. Setelah sukses, hasil dimuat ulang dan tombol berganti menjadi Lepas Relasi.

Pengujian SQL stub, HTTP, dan browser mencakup validasi, JWT, kandidat ambigu/terpakai, konfirmasi batal, request ganda, verifikasi hasil, refresh dan error. Procedure mutasi tidak dijalankan pada DB produksi selama pengembangan.

### Cek relasi dari kartu timeline

Ikon **Cek relasi** tersedia pada Kirim dan Terima, termasuk baris dihapus. `GET /transactions/relations?kind=Kirim|Terima&dumpingTonnageId=...` memakai JWT serta validasi SQL int positif. Query berparameter mengambil seluruh kolom tanpa filter penghapusan:

- Kirim: `SELECT * FROM dbo.tabCTFinalDumpingTonnage WHERE CTFinalDumpingTonnageID = @id`, ID dari `RefDumpingTonnageID`.
- Terima: `SELECT * FROM dbo.tabCTFinalLoadingTonnage WHERE CTFinalDumpingTonnageID = @id`, ID dari `CTFinalTonnageID` Terima. Semua Kirim yang menunjuknya ditampilkan.

Modal tabel menandai **Sudah dihapus** beserta waktu jika `dtDeletedAt` bukan NULL. Referensi Kirim kosong menampilkan pesan tanpa query. Loading/error/hasil kosong ditampilkan dalam modal; Tutup/Escape membatalkan request browser dan mengembalikan fokus ke tombol pembuka. Aksi ini hanya membaca DB, tidak mengikuti batas jumlah hasil timeline.

## 14. Melepas Relasi Kirim

Tombol **Lepas Relasi** tampil di samping nilai `RefDumpingTonnageID` (kartu Kirim pada timeline dan kartu pasangan di Analisa anomali) hanya jika referensi terisi. Endpoint `POST /transactions/relations` menerima `{ loadingTonnageId, confirmed: true }`; ID dibatasi integer positif.

Dalam transaksi DB, baris Kirim dikunci `UPDLOCK, HOLDLOCK`, keberadaan dan referensi saat ini diverifikasi, lalu `CTFinalDumpingTonnageID` diatur `NULL` hanya jika masih terisi; perubahan tepat satu baris wajib sebelum commit. Kirim tidak ditemukan → 404; sudah tanpa relasi atau nol baris terubah → 409; kegagalan lain → 503 dengan instruksi muat ulang.

UI meminta konfirmasi yang menyebut Kirim, Terima, dan efek `NULL`. Relasi tidak dibuat ulang otomatis, Terima tidak dihapus, dan tabel verify tidak diubah oleh aksi ini. Setelah gagal, tombol terkunci sampai pencarian ulang berhasil; tidak ada retry otomatis. Aksi ini juga memicu trigger `tr_CTFinalDumpingTonnage` pada update Kirim; trigger mengabaikan nilai NULL, tetapi tetap waspadai trigger lain yang aktif di DB produksi.
