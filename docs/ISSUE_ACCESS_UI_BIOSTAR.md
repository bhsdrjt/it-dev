# Rapikan manajemen akses, navigasi workspace, dan integrasikan Import BioStar

Status: draft issue; belum diterbitkan ke GitHub karena autentikasi issue tracker belum tersedia.
Repository tujuan: bhsdrjt/it-dev

## Cakupan pekerjaan

- Pisahkan tab User dan Role & izin; tambahkan pencarian nama/username dan filter status.
- Gunakan modal native untuk tambah user, kelola user, dan atur izin role.
- Gunakan tombol ikon dengan tooltip, label aksesibilitas, dan pengembalian fokus.
- Pertahankan validasi password, konfirmasi perubahan akses, serta pesan hasil/error dalam modal.
- Ganti istilah pengguna menjadi user pada tampilan terkait.
- Hapus deskripsi dan label tambahan yang diminta pada manajemen akses, monitoring, equipment, coal calory, dan Activity log.
- Susun navigasi: Monitoring transaksi, Equipment checks, Analisa transaksi, Timeline truck, Coal calory, Import Biostar, Manajemen akses, User Audit, Activity log.
- Sertakan implementasi BioStar yang sudah ada: backend importer, permission, konfigurasi contoh, upload/preview/konfirmasi, riwayat, tes, PRD, dan referensi DDL.
- Ganti tombol riwayat import dengan ikon history.

## Verifikasi

- Build TypeScript dan bundle frontend.
- Seluruh tes repository, termasuk browser desktop/mobile, tema terang/gelap, modal user/role, pencarian, validasi, payload simpan, dan modal riwayat import.
- Hasil tes otomatis tidak menggantikan uji integrasi terhadap database/perangkat BioStar nyata.

## Batasan dan tindak lanjut

- `.env` dan ZIP berisi paket review/export tidak disertakan dalam commit.
- DDL merupakan referensi; tidak dijalankan oleh pekerjaan ini.
- Sebelum produksi, review keamanan importer dan uji pada salinan database dengan backup: batas dekompresi ZIP, pembatasan upload sebelum buffering, serta paparan credential/fingerprint pada respons API perlu ditinjau.
- Terbitkan issue ini ke GitHub setelah akses issue tracker tersedia; tautkan commit yang memuat perubahan.
