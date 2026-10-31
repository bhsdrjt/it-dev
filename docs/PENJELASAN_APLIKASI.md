# IT Dev Ops — Penjelasan Aplikasi untuk Pengguna

Dokumen ini menjelaskan **apa itu aplikasi IT Dev Ops, untuk siapa, dan cara memakainya**, tanpa istilah teknis yang dalam. Untuk detail teknis lihat `README.md` dan `docs/PANDUAN_KODE.md`.

---

## 1. Apa aplikasi ini?

IT Dev Ops adalah **panel kerja internal berbasis web** untuk tim IT Dev Ops. Aplikasi ini menggabungkan dua pekerjaan yang biasanya terpisah:

1. **Mengelola konfigurasi *equipment check*** (flag `isGenerateCDN`) di banyak PC timbangan/lokasi — tanpa harus login satu per satu ke tiap PC.
2. **Memeriksa transaksi pengangkutan batu bara** — membandingkan data Kirim (muat) dan Terima (timbang kosong), mencari transaksi yang tidak berpasangan, dan memantau kejanggalan.

Semua tampilan berbahasa Indonesia dan hanya bisa dibuka setelah login.

---

## 2. Masalah yang diselesaikan

Sebelum aplikasi ini, tim menghadapi hal-hal berikut:

| Masalah | Dampak |
| --- | --- |
| Konfigurasi equipment check tersebar di banyak PC lokasi | Edit manual satu per satu, rawan salah PC |
| Tidak ada gambaran cepat PC mana yang hidup/mati | Baru ketahuan setelah ada keluhan operator |
| LocationID sebuah truck tidak diketahui | Harus dicari manual di tiap PC |
| Data Kirim dan Terima tidak selalu berpasangan | Ritase hilang/tertaut salah sulit ditemukan |
| Data kualitas batu bara (calory) diubah lewat DB langsung | Rawan kesalahan, tanpa riwayat di layar |

Aplikasi ini menyatukan semuanya dalam satu layar kerja.

---

## 3. Siapa penggunanya

| Peran | Yang biasa dilakukan |
| --- | --- |
| Admin IT Dev Ops | Menambah/mengubah/menghapus daftar PC target, memantau status, mengirim konfigurasi |
| Staf IT Dev Ops | Mencari truck, cek LocationID, mengirim konfigurasi, memeriksa transaksi |
| Operator/dispatcher (pembaca) | Melihat hasil analisa transaksi dan timeline truck untuk memverifikasi temuan |

Saat ini aplikasi memakai **satu akun bersama**. Belum ada pemisahan hak akses per pengguna — semua yang bisa login dapat menjalankan aksi tulis setelah konfirmasi. Karena itu akses aplikasi harus dibatasi ke tim berwenang.

---

## 4. Tiga sumber data

Penting dipahami agar tidak bingung saat ada data yang "tidak muncul":

| Data | Disimpan di | Artinya |
| --- | --- | --- |
| Daftar PC target (nama, IP, lokasi) | File `data/apis.json` di server | Dikelola dari menu Equipment checks |
| Truck, lokasi, transaksi, kualitas batu bara | SQL Server pusat | Sumber kebenaran data operasional |
| Konfigurasi equipment check | API lokal di tiap PC (`SNCAutoWBLocalAPI`) | Sumber kebenaran konfigurasi check |

Jadi: kalau database pusat mati, daftar PC tetap tampil tapi pilihan truck/lokasi gagal dimuat. Kalau PC target mati, konfigurasi check tidak bisa dibaca/dikirim.

---

## 5. Menu aplikasi

Setelah login, sisi kiri menampilkan enam menu.

### 5.1 Equipment checks

Layar utama untuk mengelola PC target dan mengirim konfigurasi.

**Ringkasan atas:** jumlah API terdaftar, jumlah online, jumlah offline, dan jumlah lokasi referensi. Status adalah **hasil pemeriksaan terakhir**, bukan pemantauan langsung.

**Panel API target:**
- Daftar PC beserta IP, status online/offline, latency (ms), dan lokasi yang dilayani.
- Tombol **ping** untuk memeriksa ulang satu PC, atau ikon di kanan atas untuk memeriksa semua PC.
- Tombol **tambah**, **edit**, dan **hapus** PC. Lokasi yang dipilih harus lokasi aktif yang terdaftar di database; kalau tidak, penyimpanan ditolak dengan pesan yang menyebut ID bermasalah.

**Panel Kirim equipment check** (alur kerjanya berurutan):
1. Pilih **API target** (PC).
2. Pilih **truck/equipment** — bisa ketik nama atau ID.
3. Aplikasi otomatis **mencari lokasi** truck tersebut di PC terpilih (lookup otomatis). Kalau PC mati, pencarian langsung berhenti dengan pesan offline, bukan menunggu lama.
4. Jika konfigurasi belum ada, pilih **LocationID** dari lokasi yang terdaftar pada PC itu.
5. Atur saklar **Generate SK** (nilai `isGenerateCDN`).
6. Klik **Kirim konfigurasi**.

Catatan: setelah pengiriman timeout, **muat ulang data sebelum mencoba lagi**. Bisa jadi PC sudah menerapkan perubahan meskipun jawabannya tidak sampai ke server.

### 5.2 Monitoring transaksi

Dasbor ringkasan temuan/kejanggalan transaksi lintas SK dan truck.

Isi layar: filter rentang waktu (24 jam / 7 hari / bulan berjalan), filter truck dan CoalDeliveryNumber, filter tingkat keparahan (kritis/warning) dan kategori (pasangan/lokasi/waktu), kartu ringkasan, grafik anomali per hari, kode temuan tersering, daftar temuan, dan daftar truck paling terdampak.

**Penting:** halaman ini masih berstatus **pratinjau** — angkanya masih data contoh dan belum terhubung ke database. Gunakan untuk melihat bentuk tampilan, belum untuk pengambilan keputusan.

### 5.3 Analisa transaksi

Menu inti untuk memeriksa satu CoalDeliveryNumber (SK) secara mendalam.

Cara pakai:
1. Masukkan **CoalDeliveryNumber**, tekan cari.
2. Aplikasi menampilkan kartu **Kirim** (muat) dan **Terima** (timbang kosong), plus aktivitas reader/timbang di sepanjang perjalanan.
3. Setiap temuan diberi kode dan tingkat (`info`/`warn`) dengan penjelasan singkat.

Aksi yang tersedia pada kartu (semua meminta konfirmasi dulu):

| Aksi | Muncul di | Fungsi |
| --- | --- | --- |
| Salin Muatan | Kirim | Menyalin muatan ke truck tujuan memakai SK yang sama |
| Generate SK Terima | Kirim | Membuat data Terima yang hilang untuk SK tersebut |
| Pasangkan Terima | Kirim tanpa relasi | Memasangkan Kirim ke Terima yang tersedia |
| Lepas Relasi | Kirim yang punya relasi | Melepas tautan Kirim–Terima (tidak menghapus data) |
| Cek relasi | Kirim & Terima | Melihat data pasangan yang ditunjuk, termasuk yang sudah dihapus |
| Hapus | Kirim & Terima | Menandai transaksi dihapus (bukan hapus permanen) |
| Masukkan ke Terima | Baris TerimaRaw | Memproses data timbang mentah menjadi Terima final |

Karena aksi di atas **mengubah data produksi**, selalu:
- baca konfirmasi sebelum menekan setuju,
- setelah gagal atau timeout, **cari ulang** untuk melihat hasil sebenarnya,
- **jangan** mengulang otomatis — hasil bisa jadi sudah tersimpan.

Penjelasan lengkap tiap aturan dan kode temuan ada di `docs/LOGIC_ANALISA_TRANSAKSI.md`.

### 5.4 Timeline truck

Menampilkan riwayat satu truck dalam rentang waktu tertentu.

1. Pilih truck (atau ketik EquipmentID).
2. Isi tanggal dan jam mulai serta selesai.
3. Pilih tab **Kirim / Terima** (transaksi final) atau **Aktivitas truck** (pembacaan reader dan timbang).

Berguna untuk menjawab "truck ini ngapain saja kemarin?" dan untuk memeriksa apakah sebuah transaksi punya pasangan di luar SK yang sedang dicari.

### 5.5 Coal calory

Mengelola data kualitas batu bara (`CoalQualityAGM`).

- Melihat daftar kualitas beserta nilai calory.
- Mencari berdasarkan ID, CoalQualityID, atau nama kualitas.
- **Edit** nama dan nilai calory (calory boleh dikosongkan).
- **Impor CSV** untuk memperbarui banyak baris sekaligus, dan **Ekspor CSV** untuk mengambil data ke Excel.
- Hapus data (dengan konfirmasi).

Perubahan di sini langsung memengaruhi database pusat dan memicu sinkronisasi internal. Periksa hasil impor sebelum mengulang.

### 5.6 Activity log

Catatan aktivitas **selama sesi halaman ini terbuka** di browser: waktu, tingkat (ok/error/info), pesan, dan catatan teknis seperti query yang dijalankan.

Ini bukan riwayat permanen dan hilang saat halaman ditutup/di-refresh. Gunakan untuk menelusuri "tadi saya klik apa dan gagal di mana".

---

## 6. Alur kerja harian yang disarankan

**Mengirim konfigurasi ke PC:**
1. Buka **Equipment checks**, klik ping semua PC.
2. Pilih PC yang online.
3. Pilih truck → cek hasil lookup lokasi.
4. Pilih lokasi (jika konfigurasi baru), atur Generate SK.
5. Kirim → baca pesan hasil → muat ulang data PC untuk memastikan.

**Memeriksa transaksi bermasalah:**
1. Dapatkan SK dari laporan/keluhan.
2. Buka **Analisa transaksi**, cari SK tersebut.
3. Baca temuan `warn` lebih dulu, lalu cocokkan dengan aktivitas.
4. Jika perlu konteks lebih luas, buka **Timeline truck** untuk truck yang sama.
5. Ambil tindakan hanya setelah bukti cukup; setiap tindakan butuh konfirmasi.

---

## 7. Arti status dan pesan umum

| Yang terlihat | Artinya | Yang perlu dilakukan |
| --- | --- | --- |
| Online + latency | PC menjawab ping/probe | Lanjut |
| Offline | PC tidak menjawab ICMP maupun TCP port 80 | Cek jaringan/PC, coba ping ulang |
| "Belum dicek" | Belum ada pemeriksaan sejak halaman dibuka | Klik ping |
| "Data tidak dimuat" | PC offline saat akan membaca konfigurasi | Hidupkan/cek PC dulu |
| "LocationID ... tidak terdaftar" | Lokasi tidak aktif atau bukan type 7 di DB | Pilih lokasi lain atau perbaiki master data |
| HTTP 503 / pesan database | Database pusat tidak terjangkau | Tunggu/koordinasikan dengan tim DB, lalu coba lagi |
| "Sesi berakhir" | Token 12 jam habis atau sesi di-reset | Login ulang |

---

## 8. Batasan yang perlu diketahui

Hal-hal berikut **belum** ada di versi ini:

- Multi-user dan pembagian hak akses (masih satu akun bersama).
- Riwayat perubahan permanen di database (audit trail).
- Notifikasi otomatis saat PC offline.
- Tampilan yang dioptimalkan untuk ponsel.
- Dasbor **Monitoring transaksi** masih memakai data contoh.

Selain itu:

- **Activity log** hanya untuk sesi browser aktif.
- Status online adalah **hasil pemeriksaan terakhir**, bukan real-time.
- Ping berhasil **tidak menjamin** layanan API di PC sehat — request data tetap bisa gagal.
- Analisa transaksi adalah **indikasi untuk diperiksa**, bukan bukti penyebab. Data yang tidak terlihat di layar belum tentu tidak ada di database.
- Konfigurasi equipment check hanya ada di PC target; aplikasi ini tidak menyimpan salinannya.

---

## 9. Keamanan singkat untuk pengguna

- Akses aplikasi lewat **HTTPS** (bukan HTTP biasa) agar password dan token tidak bisa disadap di jaringan.
- Jangan bagikan akun; semua aksi tulis tercatat atas nama akun bersama.
- Jangan menyimpan tangkapan layar berisi kredensial atau data transaksi di tempat umum.
- Jika mencurigai akun dipakai orang lain, minta admin merotasi `JWT_SECRET` — ini membatalkan semua sesi aktif.

---

## 10. Pertanyaan yang sering muncul

**Kenapa truck tidak muncul saat dicari?**
Data truck diambil dari database pusat. Kalau muncul banner error, database sedang tidak bisa diakses — klik "Coba lagi".

**Kenapa lookup lokasi bilang tidak ditemukan padahal dulu ada?**
Lookup hanya memeriksa lokasi yang terdaftar pada PC tersebut. Kalau lokasinya belum ditambahkan ke PC di registry, hasilnya tidak akan ketemu. Tambahkan lokasi lewat Edit PC.

**Saya kirim konfigurasi tapi timeout. Sudah masuk atau belum?**
Belum pasti. Muat ulang data PC (bukan kirim ulang) untuk melihat kondisi sebenarnya.

**Kenapa analisa menandai transaksi padahal datanya terlihat normal?**
Beberapa temuan bersifat `info` (misalnya MT tidak terbaca) dan bukan masalah. Fokus pada level `warn`, lalu cocokkan dengan aktivitas dan timeline.

**Apakah data yang saya hapus hilang permanen?**
Tidak. Penghapusan transaksi bersifat *soft delete* (ditandai waktu hapus), sehingga masih bisa ditelusuri lewat Cek relasi.

---

## 11. Butuh bantuan

- Cara menjalankan/men-deploy aplikasi: `README.md`.
- Aturan dan kode temuan analisa transaksi: `docs/LOGIC_ANALISA_TRANSAKSI.md`.
- Peta kode untuk pengembang: `docs/PANDUAN_KODE.md`.
