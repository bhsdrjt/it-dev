# PRD — IT Dev Ops

**Versi:** 1.0
**Status:** Draft
**Nama aplikasi:** IT Dev Ops (sebelumnya: Equipment Checks Editor)

---

## 1. Ringkasan

IT Dev Ops adalah aplikasi web internal untuk tim IT Dev Ops mengelola dan mengirim konfigurasi *equipment check* (flag `isGenerateCDN`) ke banyak PC target di jaringan lokal. Aplikasi membaca data referensi (truck/equipment dan lokasi) dari database SQL Server pusat, sementara data konfigurasi dibaca/ditulis langsung ke API lokal yang berjalan di tiap PC target (`SNCAutoWBLocalAPI`).

## 2. Masalah & Tujuan

**Masalah:**
- Konfigurasi equipment check tersebar di banyak PC lokasi, diedit manual satu per satu.
- Tidak ada cara cepat melihat PC mana yang online/offline.
- LocationID untuk sebuah truck tidak selalu diketahui, harus dicari manual di tiap PC.

**Tujuan:**
1. Satu layar untuk melihat status seluruh PC target (online/offline, latency).
2. Kirim perubahan `isGenerateCDN` ke PC target dalam beberapa klik.
3. Lookup LocationID otomatis untuk kombinasi truck + PC.
4. Kelola daftar PC target (tambah/edit/hapus) tanpa menyentuh file manual.

## 3. Pengguna

| Peran | Kebutuhan |
|---|---|
| Admin IT Dev Ops | Kelola daftar PC target, kirim konfigurasi, pantau status |
| Staf IT Dev Ops | Cari truck, cek LocationID, kirim konfigurasi |

## 4. Cakupan

### 4.1 Di dalam cakupan (Fitur)

**F1 — Autentikasi**
- Login username/password (env `AUTH_USERNAME`, `AUTH_PASSWORD`).
- Token JWT, masa berlaku 12 jam.
- Semua endpoint API (kecuali `/auth/login`) wajib token.

**F2 — Manajemen PC Target (Registry)**
- CRUD PC target: `apiName`, `ipAPI`, `locationIDs[]` (satu PC boleh melayani >1 lokasi).
- Penyimpanan di file JSON (`data/apis.json`, bisa diubah via env `APIS_FILE`).
- Tulis atomik (file sementara lalu rename), serialisasi antar-write.
- Validasi: nama & IP wajib, pola IP, LocationID harus berupa integer ≥ 0 dan terdaftar di `tabLocation` (`locationTypeID = 7`).
- BOM UTF-8 ditangani saat pembacaan file.

**F3 — Monitoring Status PC**
- Ping paralel seluruh PC: ICMP lebih dulu, fallback TCP port 80 bila ICMP diblokir firewall.
- Tampilkan status online/offline + latency (ms).
- Tombol ping ulang semua atau per-PC.

**F4 — Daftar Truck (Equipment)**
- Ambil `EquipmentID` + `strTruckCN` dari `tabEquipment`.
- Pencarian/filter nama truck.
- Nama equipment di-resolve dari DB pusat untuk baris data dari PC target.

**F5 — Daftar Lokasi**
- Ambil `LocationID` + `strLocationName` dari `tabLocation` WHERE `locationTypeID = 7` AND `dtDeletedAt IS NULL`.

**F6 — Lookup LocationID Otomatis**
- Untuk kombinasi PC target + truck, coba setiap `locationIDs` PC satu per satu terhadap API PC.
- Probe TCP cepat dulu: bila PC offline, langsung berhenti (tanpa menunggu timeout per lokasi).
- Respons: `locationID`, `locationName`, daftar lokasi yang dicek, atau pesan offline/tidak ditemukan.
- Error koneksi menghentikan percobaan lokasi berikutnya.

**F7 — Kirim Konfigurasi (Upsert)**
- Payload: `apiId`, `equipmentID`, `locationID`, `isGenerateCDN`.
- Validasi: PC ada, `locationID` termasuk `locationIDs` PC, equipment ada di `tabEquipment`, PC terjangkau (probe TCP).
- `POST {baseUrl}/api/EquipmentChecks/upsert` dengan timeout 10 detik.
- Sukses/gagal dicatat ke log UI.

**F8 — Baca Data Equipment Checks**
- `GET {baseUrl}/api/EquipmentChecks` dari PC target.
- Normalkan respons (array atau wrapped `{data|items|result}`, key case-insensitive).
- Sebelum muat: ping ulang; bila offline kembalikan pesan jelas, jangan muat data.

**F9 — Activity Log UI**
- Log panel di UI: waktu (locale `id-ID`), level (`ok`/`err`/`info`), pesan, catatan opsional.
- Log semua aksi: load, ping, add/edit/delete PC, lookup, kirim, error.
- Auto-scroll ke entri terbaru.

**F10 — Error Handling & Resilience**
- DB tidak terjangkau → HTTP 503 dengan pesan ramah pengguna; detail teknis hanya di log server.
- Connection pool SQL Server dibuat ulang otomatis setelah putus/mati.
- Pesan error selalu menyebut PC/IP yang bersangkutan.

### 4.2 Di luar cakupan (Non-goal)
- Multi-user/role management (saat ini satu akun bersama).
- Penyimpanan riwayat perubahan (audit trail) di database.
- Manajemen konfigurasi PC target via database (masih file JSON).
- Notifikasi/email alert PC offline.
- Mobile app / responsive penuh untuk layar kecil.

## 5. Arsitektur

```
[Browser SPA]
  public/index.html + React (hooks, component-based, di-bundle esbuild)
        |  HTTP + JWT
[NestJS backend :3000]
  ├─ AuthController      POST /auth/login
  ├─ ApiController       /apis, /equipments, /locations, /equipment-checks/*  (JwtGuard)
  ├─ PcRegistryService   baca/tulis data/apis.json (atomik)
  ├─ PcService           ping ICMP/TCP, HTTP ke PC target
  └─ DbService           mssql pool -> SQL Server pusat
        |
   [PC target per lokasi]  http://{ip}/SNCAutoWBLocalAPI/api/...
```

**Stack:** NestJS 12 · TypeScript · mssql · axios · ping · JWT · esbuild · React (vanilla di browser, tanpa framework build).

**Penyimpanan:**
| Data | Media |
|---|---|
| Daftar PC target | `data/apis.json` |
| Equipment, Location | SQL Server (`tabEquipment`, `tabLocation`) |
| Konfigurasi check | API di tiap PC target (sumber kebenaran) |

## 6. API

| Method | Endpoint | Deskripsi |
|---|---|---|
| POST | `/auth/login` | Login, mengembalikan token (12h) |
| GET | `/apis` | Daftar PC + hasil ping |
| POST | `/apis` | Tambah PC |
| PUT | `/apis/:id` | Edit PC |
| DELETE | `/apis/:id` | Hapus PC |
| POST | `/apis/ping` | Ping semua / satu PC |
| GET | `/equipments` | Daftar truck (DB) |
| GET | `/locations` | Daftar lokasi aktif (DB) |
| GET | `/equipment-checks?apiId=` | Ambil data check dari PC target |
| GET | `/equipment-checks/location?apiId=&equipmentId=` | Lookup LocationID otomatis |
| POST | `/equipment-checks/upsert` | Kirim `isGenerateCDN` ke PC target |

Semua endpoint selain `/auth/login` memerlukan `Authorization: Bearer <token>`.

## 7. Konfigurasi (Environment)

| Variabel | Fungsi | Default |
|---|---|---|
| `PORT` | Port server | 3000 |
| `HOST` | Bind address | 0.0.0.0 |
| `JWT_SECRET` | Secret token JWT | wajib |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | Kredensial login | wajib |
| `DB_SERVER` / `DB_DATABASE` / `DB_USER` / `DB_PASSWORD` | SQL Server pusat | wajib |
| `APIS_FILE` | Path file registry PC | `data/apis.json` |
| `API_BASE_PATH` | Path API di PC target | `/SNCAutoWBLocalAPI` |
| `PING_TIMEOUT_MS` | Timeout ping/probe | 2000 |
| `LOOKUP_TIMEOUT_MS` | Timeout lookup location | 6000 |

## 8. Kriteria Penerimaan

1. Login gagal menampilkan pesan "Username atau password salah"; login sukses mendapat token yang berlaku 12 jam.
2. Semua endpoint terproteksi JWT (tanpa token → 401).
3. Tambah/edit/hapus PC langsung tersimpan ke `data/apis.json` dan tampil setelah refresh.
4. LocationID tidak terdaftar di `tabLocation` (type 7) ditolak dengan pesan menyebut ID bermasalah.
5. Daftar PC menampilkan status online/offline + latency; PC yang memblokir ICMP tetap terdeteksi via TCP.
6. Pilih truck → LocationID dicari otomatis; bila PC offline, langsung tampil pesan offline (tanpa delay timeout).
7. Kirim konfigurasi hanya bila `locationID` terdaftar pada PC target; selain itu ditolak dengan pesan jelas.
8. DB down → pesan 503 mudah dipahami, detail teknis hanya di log server.
9. Semua aksi (termasuk error) tercatat di Activity Log UI.
10. Build: `npm start` berhasil menjalankan server dan menyajikan UI.

## 9. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| ICMP diblokir firewall Windows | Fallback TCP probe port 80 |
| Banyak PC offline → lookup lambat | Probe TCP cepat sebelum loop lokasi; stop pada error koneksi |
| Registry JSON ditulis manual sambil app jalan | Baca ulang tiap request; tulis atomik + serial |
| DB pusat tidak terjangkau | 503 dengan pesan ramah; pool auto-reconnect |
| Satu akun bersama | (Peningkatan) tambah user management di versi berikutnya |

## 10. Rencana Versi

| Versi | Isi |
|---|---|
| 1.0 | Fitur F1–F10 (status saat ini) |
| 1.1 | Riwayat perubahan (audit log di DB) |
| 1.2 | Multi-user + role (admin/operator) |
| 2.0 | Notifikasi PC offline, dasbor ringkasan multi-lokasi |
