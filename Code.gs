/*******************************************************************
 * CHECKLIST FURNACE AREA - BACKEND (Google Apps Script)
 * -----------------------------------------------------------------
 * Deploy as Web App:
 *   Deploy > New deployment > Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Copy the /exec URL into API_URL constant inside index.html
 *
 * REQUIRED SHEETS (run setupSheets() once from the editor to create
 * / fix headers automatically):
 *
 * 1) "TATA CARA"  -> user table, columns E..O (matches existing sheet):
 *    E:Username F:Password G:Salt H:FullName I:JobTitle J:Role
 *    K:Status  L:CreatedAt M:Token N:TokenExpiry O:LastDevice
 *    Row 1 = header, data starts row 2.
 *    Status values: Pending / Accept / Reject  (dropdown already set)
 *    Role values : operator / supervisor / superintendent / engineer
 *
 * 2) "Database Checklist" -> all checklist submissions (V2 layout):
 *    A:Timestamp B:ID C:Type D:ChecklistName E:Tanggal F:Shift G:Group
 *    H:DataJSON I:Status J:CreatedBy K:CreatedAt L:UpdatedBy M:UpdatedAt
 *    N:FinalizedBy O:FinalizedAt P:Signature Operator Q:Signature Supervisor
 *    R:Signature Superintendent
 *    -> "Timestamp" (col A) always reflects the most recent time the row
 *       was written to (any save/final/revert action).
 *    -> "CreatedAt" (col K) is only ever written ONCE, the very first time
 *       the row is created.
 *    -> Each Signature column stores that person's JSON {name, img} only
 *       (img = base64 PNG data URL from the signature pad), instead of a
 *       single combined "Signatures" JSON column like before.
 *    If you already have an OLDER sheet (no Timestamp column, one combined
 *    "Signatures" column instead of P/Q/R) run migrateDatabaseChecklistV2()
 *    ONCE from the Apps Script editor to upgrade it in place without
 *    losing data. Safe to run more than once (it checks the header first).
 *
 * 3) "Form Fisik" -> a small control sheet to preview/print any submitted
 *    checklist using the *actual* template sheet design ("Skimming NEW",
 *    "Tapping NEW", "HMC NEW", ...). Run setupFormFisikSheet() once to
 *    build the input controls (dropdowns) in B1:B5. Every time B1..B5
 *    changes, onEdit() automatically calls renderFormFisik() which:
 *      1. Copies the matching "<Nama> NEW" template's layout below the
 *         inputs.
 *      2. Looks up the matching row in "Database Checklist".
 *      3. Locates each checklist item's row *by matching the item text*
 *         (not a fixed row number) so it keeps working even if the
 *         template has extra header/category rows in between.
 *      4. Writes Hasil/Catatan (awal & akhir shift) into the columns you
 *         configure in FORM_FISIK_CONFIG below, and drops the signature
 *         images into the cells you configure too.
 *    IMPORTANT: I cannot see the real cell layout of your "... NEW"
 *    template sheets, so FORM_FISIK_CONFIG below is a best-guess starting
 *    point. Open FORM_FISIK_CONFIG and adjust itemLabelCol / the 4 result
 *    columns / headerCells / sigCells so they point at the right columns
 *    in your real templates (see comments right above the constant).
 *******************************************************************/

const USERS_SHEET = "TATA CARA";
const USERS_HEADER_ROW = 1;
const USERS_FIRST_DATA_ROW = 2;
const USERS_COLS = { // 1-based column index
  username: 5, password: 6, salt: 7, fullName: 8, jobTitle: 9,
  role: 10, status: 11, createdAt: 12, token: 13, tokenExpiry: 14, lastDevice: 15, shift: 16
};

const DB_SHEET = "Database Checklist";
// V2 layout (18 columns, A..R) - see header comment block above.
const DB_COLS = {
  timestamp:1, id:2, type:3, checklistName:4, tanggal:5, shift:6, group:7,
  dataJson:8, status:9, createdBy:10, createdAt:11, updatedBy:12, updatedAt:13,
  finalizedBy:14, finalizedAt:15, sigOperator:16, sigSupervisor:17, sigSuperintendent:18
};
const DB_HEADER = ["Timestamp","ID","Type","ChecklistName","Tanggal","Shift","Group","DataJSON",
  "Status","CreatedBy","CreatedAt","UpdatedBy","UpdatedAt","FinalizedBy","FinalizedAt",
  "Signature Operator","Signature Supervisor","Signature Superintendent"];
const DB_TOTAL_COLS = DB_HEADER.length; // 18

const TOKEN_LIFETIME_HOURS = 10;

/* ======================= CHECKLIST DEFINITIONS (FALLBACK ONLY now) =======================
 * This used to be the primary source of truth, kept in sync by hand with
 * an identical copy inside index.html. It's now only a FALLBACK: the
 * real item list is read fresh off "Skimming NEW"/"Tapping NEW"/"HMC NEW"
 * every time (see getChecklistDefs_ / parseChecklistDefinitionFromSheet_
 * further down), and index.html fetches that dynamically instead of
 * carrying its own copy. This constant is used only if that parse fails
 * for a given checklist (sheet restructured, header renamed, etc.) - see
 * getChecklistDefs_'s fallback logic. Safe to leave stale; it's a safety
 * net, not something that needs updating when the template sheets change. */
const CHECKLIST_DATA = {"skimming": {"title": "Skimming", "version": "2025 11 18", "items": [{"kat": "Stasiun Hidrolik", "item": "Housing Pompa", "kode": "VS", "std": "Suara halus dan tidak ada kebocoran", "pos": "Pompa Oli"}, {"kat": "Stasiun Hidrolik", "item": "Kebocoran Oli", "kode": "V", "std": "Tidak ada kebocoran oli dari saluran masuk maupun keluar", "pos": "Pompa Oli"}, {"kat": "Stasiun Hidrolik", "item": "Level & Temperatur Oli", "kode": "V", "std": "Level oli di atas 1/2,\nTemperatur oli ≤50°C", "pos": "Tangki Oli"}, {"kat": "Stasiun Hidrolik", "item": "Tekanan", "kode": "V", "std": "Sesuai standar (11-12 MPa)", "pos": "Sistem Hidrolik"}, {"kat": "Stasiun Hidrolik", "item": "Valve", "kode": "VT", "std": "Mudah diputar dan tidak macet", "pos": "Sistem Hidrolik"}, {"kat": "Stasiun Hidrolik", "item": "Kebocoran Oli", "kode": "V", "std": "Kondisi bagus, tidak ada kebocoran oli", "pos": "Sistem Hidrolik"}, {"kat": "Stasiun Hidrolik", "item": "Sambungan Pipa & Selang", "kode": "V", "std": "Tidak longgar dan tidak ada kebocoran oli", "pos": "Sistem Auxiliary"}, {"kat": "Handle Control / Solenoid", "item": "Test Pergerakan Mudgun", "kode": "VST", "std": "Test swing & posisikan di depan hole", "pos": "Handle Control Mudgun"}, {"kat": "Handle Control / Solenoid", "item": "Test Pergerakan Drill", "kode": "VST", "std": "Test swing & posisikan drill maju / mundur", "pos": "Handle Control Drill"}, {"kat": "Mud/Clay Gun", "item": "Silinder Mud/Clay & Pipa Oli", "kode": "V", "std": "Pengoperasian stabil, tidak macet dan tidak ada kebocoran oli", "pos": "Mekanisme Pemompaan Mud/Clay"}, {"kat": "Mud/Clay Gun", "item": "Tabung Mud/Clay & Parts Ekstension", "kode": "V", "std": "Tidak ada deformasi", "pos": "Mekanisme Pemompaan Mud/Clay"}, {"kat": "Mud/Clay Gun", "item": "Plat Pengaman dan Penarik", "kode": "V", "std": "Tidak ada deformasi, kelonggaran maupun las-lasan terbuka", "pos": "Plat Pengaman dan Penarik"}, {"kat": "Mud/Clay Gun", "item": "Silinder Pengangkatan", "kode": "V", "std": "Pengoperasian stabil, tidak macet dan tidak ada kebocoran oli", "pos": "Mekanisme Pengangkatan"}, {"kat": "Mesin Drill", "item": "Putaran", "kode": "V", "std": "Pengoperasian stabil, tidak macet", "pos": "Mekanisme Perputaran"}, {"kat": "Mesin Drill", "item": "Kebocoran Oli", "kode": "V", "std": "Tidak ada kebocoran oli dari sambungan", "pos": "Mekanisme Perputaran"}, {"kat": "Mesin Drill", "item": "Silinder Pengangkatan", "kode": "V", "std": "Pengoperasian stabil, tidak macet dan tidak ada kebocoran oli", "pos": "Mekanisme Pengangkatan"}, {"kat": "Mesin Drill", "item": "Motor \nMaju & Mundur", "kode": "V", "std": "Tidak macet", "pos": "Trolley Perpindahan"}, {"kat": "Mesin Drill", "item": "Pipa Oli \nRantai Penarikan", "kode": "V", "std": "Tidak ada deformasi dan kebocoran oli", "pos": "Trolley Perpindahan"}, {"kat": "Mesin Drill", "item": "Pipa & Sambungan", "kode": "V", "std": "Tidak ada keretakan, sealing normal", "pos": "Trolley Perpindahan"}, {"kat": "Mesin Drill", "item": "Rantai", "kode": "V", "std": "Baut tidak kendor maupun macet", "pos": "Part Transmisi"}, {"kat": "Launder", "item": "Kondisi Cover Plate", "kode": "VT", "std": "Kondisi baik, diperbaiki dengan green clay apabila diperlukan", "pos": "Cover Plate"}, {"kat": "Launder", "item": "Kondisi Launder", "kode": "V", "std": "Kondisi bowl bagus, tidak ada kerusakan, ramming kondisi baik", "pos": "Launder atas hingga tengah"}, {"kat": "Launder", "item": "Kondisi Launder", "kode": "V", "std": "Kondisi bagus, tidak ada kerusakan", "pos": "Launder bagian ujung"}, {"kat": "Launder", "item": "Wet Launder", "kode": "V", "std": "Kondisi wet launder dalam keadaan baik, water granulation berfungsi baik", "pos": "Wet Launder"}, {"kat": "Safety", "item": "Aluminized Suit", "kode": "VT", "std": "Aluminized suit (hood, baju, celana, spat, glove) tersedia untuk digunakan", "pos": "Aluminized Suit"}, {"kat": "Safety", "item": "Face Shield", "kode": "V", "std": "Face shield tersedia untuk digunakan", "pos": "Face Shield"}, {"kat": "Safety", "item": "Gloves Tahan Panas", "kode": "VT", "std": "Gloves tersedia untuk digunakan", "pos": "Gloves Tahan Panas"}, {"kat": "Safety", "item": "APAR / Fire Extinguisher", "kode": "VT", "std": "Tersedia APAR dry powder (cek tekanan-nya)", "pos": "APAR"}, {"kat": "Safety", "item": "On-Site Gas Analyzer", "kode": "V", "std": "Gas analyzer CO berfungsi", "pos": "CO Analyzer"}, {"kat": "Peralatan Penunjang", "item": "Pipe Lancing", "kode": "V", "std": "Pipa lancing tersedia & siap digunakan", "pos": "Pipe Lancing"}, {"kat": "Peralatan Penunjang", "item": "Connector", "kode": "VT", "std": "Connector & hose tersambung ke sumber oxygen dengan kondisi baik", "pos": "Connector"}, {"kat": "Peralatan Penunjang", "item": "Pencungkil Build Up", "kode": "V", "std": "Pencungkil & peralatan penunjang lainnya tersedia & siap digunakan", "pos": "Pencungkil Build Up"}, {"kat": "Peralatan Penunjang", "item": "Sendok & Cetakan Sample", "kode": "VT", "std": "Sendok & cetakan sampel tersedia, diberi kapur / ramming, & sudah dipanaskan", "pos": "Sendok & Cetakan Sample"}, {"kat": "Peralatan Penunjang", "item": "Temp Tip & Rod", "kode": "V", "std": "Temp rod berfungsi & stok temp tip tersedia di area", "pos": "Temp Tip & Rod"}, {"kat": "Peralatan Penunjang", "item": "Emergency Plug", "kode": "V", "std": "Emergency plug tersedia di area untuk kondisi emergency", "pos": "Emergency Plug & Palu 5 kg"}, {"kat": "Peralatan Penunjang", "item": "Oven Body & Temp Controller", "kode": "VT", "std": "Oven berfungsi dengan baik, temp 80-100 C", "pos": "Oven"}, {"kat": "Peralatan Penunjang", "item": "Lampu di sebelah Utara & Selatan", "kode": "V", "std": "Lampu berfungsi dengan baik", "pos": "Lampu Penerangan"}, {"kat": "Peralatan Penunjang", "item": "Exhaust Hood Utara & Selatan", "kode": "VT", "std": "Exhaust (HVAC system) bekerja dengan baik", "pos": "Exhaust Hood"}, {"kat": "Peralatan Penunjang", "item": "Blower Cooling Fan", "kode": "V", "std": "Blower tersedia & berfungsi dengan baik", "pos": "Blower Fan"}, {"kat": "Materials", "item": "Clay Mudgun", "kode": "V", "std": "Clay tersedia di area skimming & siap digunakan (sudah di oven)", "pos": "Clay Mudgun"}, {"kat": "Materials", "item": "Oxygen Source", "kode": "V", "std": "Sumber oxygen tersedia dengan minimal press 1 Mpa", "pos": "Oxygen Source"}, {"kat": "Materials", "item": "Pasir Kuning, Sekam Padi, Kapur", "kode": "V", "std": "Pasir, sekam padi, kapur tersedia di bagian Utara maupun Selatan launder", "pos": "Pasir Kuning, Sekam Padi, Kapur"}, {"kat": "Materials", "item": "Ramming Material", "kode": "V", "std": "Ramming material tersedia di area untuk service launder", "pos": "Ramming Material"}, {"kat": "Coordination", "item": "Koordinasi CCR, Water Checker, & Clamshell", "kode": "V", "std": "Memastikan kesiapan area downstream untuk memproses slag yang di granulasi", "pos": "Koordinasi Fokker Base"}]}, "tapping": {"title": "Tapping", "version": "2025 10 18", "items": [{"kat": "Stasiun Hidrolik", "item": "Housing Pompa", "kode": "VS", "std": "Suara halus & tidak ada kebocoran", "pos": "Pompa Oli"}, {"kat": "Stasiun Hidrolik", "item": "Kebocoran Oli", "kode": "V", "std": "Tidak ada kebocoran oli dari saluran masuk maupun keluar", "pos": "Pompa Oli"}, {"kat": "Stasiun Hidrolik", "item": "Level & Temperatur Oli", "kode": "V", "std": "Level oli di atas 1/2, Temperatur oli ≤ 50°C", "pos": "Tangki Oli"}, {"kat": "Stasiun Hidrolik", "item": "Tekanan", "kode": "V", "std": "Sesuai standar (11-12 MPa)", "pos": "Sistem Hidrolik"}, {"kat": "Stasiun Hidrolik", "item": "Valve", "kode": "VT", "std": "Mudah diputar & tidak macet", "pos": "Sistem Hidrolik"}, {"kat": "Stasiun Hidrolik", "item": "Kebocoran Oli", "kode": "V", "std": "Kondisi bagus, tidak ada kebocoran oli", "pos": "Sistem Hidrolik"}, {"kat": "Stasiun Hidrolik", "item": "Sambungan Pipa & Selang", "kode": "V", "std": "Tidak longgar & tidak ada kebocoran oli", "pos": "Sistem Auxiliary"}, {"kat": "Handle Control / Solenoid", "item": "Test Pergerakan Mudgun", "kode": "VST", "std": "Test swing & posisikan di depan tapping hole", "pos": "Handle Control Mudgun"}, {"kat": "Handle Control / Solenoid", "item": "Test Pergerakan Drill", "kode": "VST", "std": "Test swing & posisikan drill maju / mundur", "pos": "Handle Control Drill"}, {"kat": "Mud/Clay Gun", "item": "Silinder Mud/Clay & Pipa Oli", "kode": "V", "std": "Pengoperasian stabil, tidak macet & tidak ada kebocoran oli", "pos": "Mekanisme Pemompaan Mud/Clay"}, {"kat": "Mud/Clay Gun", "item": "Tabung Mud/Clay & Parts Ekstension", "kode": "V", "std": "Tidak ada deformasi", "pos": "Mekanisme Pemompaan Mud/Clay"}, {"kat": "Mud/Clay Gun", "item": "Plat Pengaman & Penarik", "kode": "V", "std": "Tidak ada deformasi, kelonggaran maupun las-lasan terbuka", "pos": "Plat Pengaman & Penarik"}, {"kat": "Mud/Clay Gun", "item": "Silinder Pengangkatan", "kode": "V", "std": "Pengoperasian stabil, tidak macet & tidak ada kebocoran oli", "pos": "Mekanisme Pengangkatan"}, {"kat": "Mesin Drill", "item": "Kondisi Drill Bit & Rod", "kode": "VT", "std": "Drill dalam kondisi baik, pastikan stok tersedia apabila perlu diganti", "pos": "Drill Bit & Rod"}, {"kat": "Mesin Drill", "item": "Putaran", "kode": "V", "std": "Pengoperasian stabil, tidak macet", "pos": "Mekanisme Perputaran"}, {"kat": "Mesin Drill", "item": "Kebocoran Oli", "kode": "V", "std": "Tidak ada kebocoran oli dari sambungan", "pos": "Mekanisme Perputaran"}, {"kat": "Mesin Drill", "item": "Silinder Pengangkatan", "kode": "V", "std": "Pengoperasian stabil, tidak macet & tidak ada kebocoran oli", "pos": "Mekanisme Pengangkatan"}, {"kat": "Mesin Drill", "item": "Motor Maju & Mundur", "kode": "V", "std": "Tidak macet", "pos": "Trolley Perpindahan"}, {"kat": "Mesin Drill", "item": "Pipa Oli & Rantai Penarikan", "kode": "V", "std": "Tidak ada deformasi & kebocoran oli", "pos": "Trolley Perpindahan"}, {"kat": "Mesin Drill", "item": "Pipa & Sambungan", "kode": "V", "std": "Tidak ada keretakan, sealing normal", "pos": "Trolley Perpindahan"}, {"kat": "Mesin Drill", "item": "Rantai", "kode": "V", "std": "Baut tidak kendor maupun macet", "pos": "Part Transmisi"}, {"kat": "Launder", "item": "Kondisi Cover Plate", "kode": "VT", "std": "Kondisi baik, diperbaiki dengan green clay apabila diperlukan", "pos": "Cover Plate"}, {"kat": "Launder", "item": "Kondisi Launder", "kode": "V", "std": "Kondisi bagus, tidak ada kerusakan, ramming kondisi baik", "pos": "Launder atas hingga tengah"}, {"kat": "Launder", "item": "Kondisi Launder", "kode": "V", "std": "Kondisi bagus, tidak ada kerusakan", "pos": "Launder bagian ujung"}, {"kat": "Launder", "item": "Heating Up Launder", "kode": "V", "std": "Launder dipanaskan pastikan tidak ada air & minimalisir heat loss", "pos": "Heating Up Launder"}, {"kat": "Ladle ", "item": "Kondisi Ladle", "kode": "V", "std": "Ladle telah dipanaskan (temp shell ladle > 200 C) & tidak ada air didalam ladle", "pos": "Kondisi Ladle"}, {"kat": "Ladle ", "item": "Posisi Ladle ", "kode": "V", "std": "Posisi tepat di bawah ujung launder & \"mulut\" menghadap Timur", "pos": "Posisi"}, {"kat": "Safety", "item": "Aluminized Suit", "kode": "VT", "std": "Aluminized suit (hood, baju, celana, spat, glove) tersedia untuk digunakan", "pos": "Aluminized Suit"}, {"kat": "Safety", "item": "Face Shield", "kode": "V", "std": "Face shield tersedia untuk digunakan", "pos": "Face Shield"}, {"kat": "Safety", "item": "Gloves Tahan Panas", "kode": "VT", "std": "Gloves tersedia untuk digunakan", "pos": "Gloves Tahan Panas"}, {"kat": "Safety", "item": "APAR / Fire Extinguisher", "kode": "VT", "std": "Tersedia APAR dry powder (cek tekanan-nya)", "pos": "APAR"}, {"kat": "Peralatan Penunjang", "item": "Pipe Lancing", "kode": "V", "std": "Pipa lancing tersedia & siap digunakan", "pos": "Pipe Lancing"}, {"kat": "Peralatan Penunjang", "item": "Connector", "kode": "VT", "std": "Connector & hose tersambung ke sumber oxygen dengan kondisi baik", "pos": "Connector"}, {"kat": "Peralatan Penunjang", "item": "Pencungkil Build Up", "kode": "V", "std": "Pencungkil & peralatan penunjang lainnya tersedia & siap digunakan", "pos": "Pencungkil Build Up"}, {"kat": "Peralatan Penunjang", "item": "Sendok & Cetakan Sample", "kode": "VT", "std": "Sendok & cetakan sampel tersedia, diberi kapur / ramming, & sudah dipanaskan", "pos": "Sendok & Cetakan Sample"}, {"kat": "Peralatan Penunjang", "item": "Temp Tip & Rod", "kode": "V", "std": "Temp rod berfungsi & stok temp tip tersedia di area tapping", "pos": "Temp Tip & Rod"}, {"kat": "Peralatan Penunjang", "item": "Emergency Plug", "kode": "V", "std": "Emergency plug tersedia di area tapping untuk kondisi emergency", "pos": "Emergency Plug & Palu 5 kg"}, {"kat": "Peralatan Penunjang", "item": "Oven Body & Temp Controller", "kode": "VT", "std": "Oven berfungsi dengan baik, temp 80-100 C", "pos": "Oven"}, {"kat": "Materials", "item": "Clay Mudgun", "kode": "V", "std": "Clay tersedia di area tapping & siap digunakan (sudah di oven)", "pos": "Clay Mudgun"}, {"kat": "Materials", "item": "Oxygen Source", "kode": "V", "std": "Sumber oxygen tersedia dengan minimal press 1 Mpa", "pos": "Oxygen Source"}, {"kat": "Materials", "item": "Pasir Kuning, Sekam Padi, Kapur", "kode": "V", "std": "Pasir, sekam padi, kapur tersedia di bagian Utara maupun Selatan launder tapping", "pos": "Pasir Kuning, Sekam Padi, Kapur"}, {"kat": "Materials", "item": "Ramming Material", "kode": "V", "std": "Ramming material tersedia di area tapping untuk service launder", "pos": "Ramming Material"}, {"kat": "Coordination", "item": "Koordinasi HMC & Shotting", "kode": "V", "std": "Memastikan kesiapan area downstream untuk memproses FeNi yang di tapping", "pos": "Koordinasi HMC & Shotting"}]}, "hmc": {"title": "Hot Metal Crane (HMC)", "version": "2026 01 30", "items": [{"kat": "Main Hoist", "item": "Fungsi kontrol main hoist", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality, hoist naik turun/turun gerak halus tanpa hentakan"}, {"kat": "Main Hoist", "item": "Fungsi upper limit", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality, limit switch hoist memutus arus saat posisi atas/bawah tercapai"}, {"kat": "Main Hoist", "item": "Fungsi lower limit", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality, limit switch hoist memutus arus saat posisi atas/bawah tercapai"}, {"kat": "Main Hoist", "item": "Drum hoist", "kode": "V", "std": "Drum hoist alur bersih,tanpa kerusakan"}, {"kat": "Main Hoist", "item": "Bearing dan gear box", "kode": "V", "std": "Bearing dan gear box pelumasan cukup, tidak bocor oli/grease"}, {"kat": "Main Hoist", "item": "Kondisi upper limit", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Main Hoist", "item": "Kondisi wire rope", "kode": "V", "std": "Tidak ada abnormality, wire rope utama tidak ada kawat putus, tidak kusut, tidak korosi"}, {"kat": "Main Hoist", "item": "Kondisi shaft pulley", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Main Hoist", "item": "Kondisi bale Utara", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality, hook / block hook tidak retak"}, {"kat": "Main Hoist", "item": "Kondisi bale Selatan", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality, hook / block hook tidak retak"}, {"kat": "Main Hoist", "item": "Kondisi lock pin bale", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Main Hoist", "item": "Sistem Pengereman", "kode": "V", "std": "Sistem rem utama respon cepat, tidak slip, sistem pengereman berhenti tepat saat kontrol di lepas"}, {"kat": "Main Hoist", "item": "Rem darurat", "kode": "V", "std": "Rem darurat aktif saat pengujian"}, {"kat": "Aux Hoist", "item": "Auxilliary", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Aux Hoist", "item": "Fungsi upper limit", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Aux Hoist", "item": "Fungsi lower limit", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Aux Hoist", "item": "Fungsi power limit", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Aux Hoist", "item": "Kondisi wire rope", "kode": "V", "std": "Tidak ada abnormality, wire rope utama tidak ada kawat putus, tidak kusut, tidak korosi"}, {"kat": "Aux Hoist", "item": "Kondisi hook lock", "kode": "V", "std": "Kondisi hook & safety latch tidak rusak / tidak ada abnormality"}, {"kat": "Bridge", "item": "Fungsi kontrol bridge", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality, bridge travel pergerakan stabil, tidak ada suara abnormal, bridge kiri/ kanan gerak lancar tidak bergetar"}, {"kat": "Bridge", "item": "Fungsi rem", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Bridge", "item": "Kondisi shaft drive", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Bridge", "item": "Stop block", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Trolly", "item": "Fungsi kontrol trolly", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality, trolly travel pergerakan halus, tidak tersendat, trolly maju/ mundur gerak stabil tidak melenceng"}, {"kat": "Trolly", "item": "Kondisi safety wood", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Trolly", "item": "Stop block", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Trolly", "item": "Saklar utama", "kode": "V", "std": "Saklar utama berfungsi dan tidak longgar"}, {"kat": "Trolly", "item": "Lampu indikator", "kode": "V", "std": "Lampu indikator dan display menyala normal"}, {"kat": "Trolly", "item": "Limit switch hoist", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Trolly", "item": "Limit switch troley", "kode": "V", "std": "Limit swicth trolly dan bridge memutus arus saat batas tercapai"}, {"kat": "Trolly", "item": "Kabel daya", "kode": "V", "std": "Kabel daya dan kontrol tidak terkelupas,tidak longgar"}, {"kat": "Trolly", "item": "Emergency stop", "kode": "V", "std": "Emergensi stop memutus arus saat di tekan"}, {"kat": "Cabin Operator", "item": "Fungsi tombol power kontrol", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality, panel kontrol bersih, bebas debu dan air, pintu terkunci"}, {"kat": "Cabin Operator", "item": "Panel monitor", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Cabin Operator", "item": "Display timbangan", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Cabin Operator", "item": "Fungsi camera", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Cabin Operator", "item": "Monitor camera", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Cabin Operator", "item": "Fungsi AC", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Cabin Operator", "item": "Fungsi radio", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Cabin Operator", "item": "Fungsi horn", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Cabin Operator", "item": "Kondisi kaca kabin", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Cabin Operator", "item": "Kondisi tempat duduk", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality"}, {"kat": "Cabin Operator", "item": "Kondisi tangga", "kode": "V", "std": "Kondisi tidak rusak / tidak ada abnormality, tangga & platform kerja tidak licin, railing kokoh"}, {"kat": "Pemeriksaan Struktur", "item": "Girder", "kode": "V", "std": "Main girder dan end carriage tidak ada retakan,deformasi,atau karat parah"}, {"kat": "Pemeriksaan Struktur", "item": "Sambungan & las baut", "kode": "V", "std": "Sambungan dan las baut kencang las utuh"}, {"kat": "Pemeriksaan Struktur", "item": "Rel crane", "kode": "V", "std": "Rel crane dan roda tidak aus berlebihan,bebas dari halangan/debu tebal"}, {"kat": "Sistem Keselamatan", "item": "Alarm / Horn / Lampu / Sirene Peringatan", "kode": "VS", "std": "Alarm dan horn bunyi jelas, alarm dan lampu aktif saat operasi menyala otomatis, sirene peringatan beban panas aktif saat angkat beban"}, {"kat": "Sistem Keselamatan", "item": "Botol pemadam (APAR)", "kode": "V", "std": "APAR (pemadam) tekanan normal, tidak kadaluarsa"}, {"kat": "Sistem Keselamatan", "item": "Jalur evakuasi", "kode": "V", "std": "Jalur evakuasi aman, bebas hambatan"}, {"kat": "Sistem Keselamatan", "item": "Rambu K3 / Safety Sign", "kode": "V", "std": "Rambu K3 (peringatan, larangan, wajib, informasi) terpasang lengkap, jelas terbaca, kondisi tidak rusak"}]}};

/* ================= WEB APP ENTRY POINTS ================= */

function doGet(e){
  return jsonOut({ok:true, data:{message:"Checklist Furnace API is running."}});
}

function doPost(e){
  let body;
  try{
    body = JSON.parse(e.postData.contents);
  }catch(err){
    return jsonOut({ok:false, error:"Invalid request body."});
  }
  const action = body.action;
  try{
    switch(action){
      case "register": return jsonOut({ok:true, data: actionRegister(body)});
      case "login": return jsonOut({ok:true, data: actionLogin(body)});
      case "getChecklistDefs": return jsonOut({ok:true, data: getChecklistDefs_()});
      case "getNotifications": return jsonOut({ok:true, data: actionGetNotifications(body)});
      case "getChecklist": return jsonOut({ok:true, data: actionGetChecklist(body)});
      case "saveDraft": return jsonOut({ok:true, data: actionSaveOrSubmit(body, "Draft")});
      case "saveProgress": return jsonOut({ok:true, data: actionSaveOrSubmit(body, null)});
      case "submitToSupervisor": return jsonOut({ok:true, data: actionSaveOrSubmit(body, "Menunggu Supervisor")});
      case "submitToSuperintendent": return jsonOut({ok:true, data: actionSaveOrSubmit(body, "Menunggu Superintendent")});
      case "submitFinal": return jsonOut({ok:true, data: actionSaveOrSubmit(body, "Final")});
      case "setDraft": return jsonOut({ok:true, data: actionSetDraft(body)});
      default: return jsonOut({ok:false, error:"Unknown action: " + action});
    }
  }catch(err){
    return jsonOut({ok:false, error: err.message});
  }
}

function jsonOut(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ================= SETUP HELPER (run manually once) ================= */
function setupSheets(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Users sheet - only create headers if the sheet is empty; if you already
  // have data (see screenshot) this will NOT overwrite it.
  let us = ss.getSheetByName(USERS_SHEET);
  if(!us){ us = ss.insertSheet(USERS_SHEET); }
  const headerVals = ["Username","Password","Salt","FullName","JobTitle","Role","Status","CreatedAt","Token","TokenExpiry","LastDevice","SHIFT"];
  const existing = us.getRange(1, USERS_COLS.username, 1, headerVals.length).getValues()[0];
  if(existing.join("") === ""){
    us.getRange(1, USERS_COLS.username, 1, headerVals.length).setValues([headerVals]);
  }

  // Database Checklist sheet (V2 layout)
  let db = ss.getSheetByName(DB_SHEET);
  if(!db){ db = ss.insertSheet(DB_SHEET); }
  const dbExisting = db.getRange(1,1,1,DB_HEADER.length).getValues()[0];
  if(dbExisting.join("") === ""){
    db.getRange(1,1,1,DB_HEADER.length).setValues([DB_HEADER]);
    db.setFrozenRows(1);
  }

  setupFormFisikSheet();
  setupDemografiSheet();

  SpreadsheetApp.getUi().alert("Setup selesai. Sheet 'TATA CARA', 'Database Checklist', 'Form Fisik' & 'Demografi' siap digunakan.");
}

/* ================= FIX: add header row if data was written before
 * setupSheets() ran. Safe to run multiple times. ================= */
function fixDatabaseHeader(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const db = ss.getSheetByName(DB_SHEET);
  if(!db){ SpreadsheetApp.getUi().alert("Sheet 'Database Checklist' tidak ditemukan."); return; }
  const a1 = db.getRange(1,1).getValue();
  if(String(a1).trim() === "Timestamp"){
    SpreadsheetApp.getUi().alert("Header sudah benar, tidak ada yang perlu diperbaiki.");
    return;
  }
  if(db.getLastRow() === 0){
    db.getRange(1,1,1,DB_HEADER.length).setValues([DB_HEADER]);
  } else {
    db.insertRowBefore(1);
    db.getRange(1,1,1,DB_HEADER.length).setValues([DB_HEADER]);
  }
  db.setFrozenRows(1);
  SpreadsheetApp.getUi().alert("Selesai. Baris header V2 ditambahkan di atas data yang sudah ada.");
}

/* ================= ONE-TIME MIGRATION: OLD LAYOUT -> V2 LAYOUT =================
 * Old layout (15 cols, no Timestamp, 1 combined "Signatures" JSON column):
 *   A:ID B:Type C:ChecklistName D:Tanggal E:Shift F:Group G:DataJSON
 *   H:Signatures I:Status J:CreatedBy K:CreatedAt L:UpdatedBy M:UpdatedAt
 *   N:FinalizedBy O:FinalizedAt
 * New layout (V2, 18 cols) - see header comment block at top of file.
 * Run this ONCE from the Apps Script editor if your sheet still has the
 * OLD layout. It inserts the Timestamp column, splits the combined
 * Signatures JSON into the 3 new columns, and removes the old column.
 * Does nothing (shows an alert) if the sheet is already V2. */
function migrateDatabaseChecklistV2(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const db = ss.getSheetByName(DB_SHEET);
  if(!db){ SpreadsheetApp.getUi().alert("Sheet 'Database Checklist' tidak ditemukan."); return; }
  const a1 = String(db.getRange(1,1).getValue()).trim();
  if(a1 === "Timestamp"){
    SpreadsheetApp.getUi().alert("Sheet sudah menggunakan layout V2, tidak perlu migrasi.");
    return;
  }
  if(a1 !== "ID"){
    SpreadsheetApp.getUi().alert("Header baris 1 tidak dikenali (bukan 'ID' atau 'Timestamp'). Migrasi dibatalkan untuk keamanan data - hubungi developer.");
    return;
  }
  const lastRow = db.getLastRow();
  const OLD = {id:1, type:2, checklistName:3, tanggal:4, shift:5, group:6, dataJson:7,
    signatures:8, status:9, createdBy:10, createdAt:11, updatedBy:12, updatedAt:13,
    finalizedBy:14, finalizedAt:15};

  let oldData = [];
  if(lastRow >= 2){
    oldData = db.getRange(2,1,lastRow-1,15).getValues();
  }

  // 1. Insert Timestamp column at the very front.
  db.insertColumnBefore(1);
  // 2. Append 2 more columns at the end (for supervisor & superintendent -
  //    the old col H "Signatures" will be reused/renamed for Operator).
  db.insertColumnAfter(db.getLastColumn());
  db.insertColumnAfter(db.getLastColumn());

  // After inserting 1 col at the front, every old column shifts +1.
  const SHIFT = 1;
  const newSignaturesCol = OLD.signatures + SHIFT; // old combined JSON column, now becomes "Signature Operator"
  const sigSupervisorCol = DB_TOTAL_COLS - 1; // second-to-last
  const sigSuperintendentCol = DB_TOTAL_COLS; // last

  // 3. Rewrite header row completely to the canonical V2 header.
  db.getRange(1,1,1,DB_TOTAL_COLS).setValues([DB_HEADER]);
  db.setFrozenRows(1);

  // 4. Fill Timestamp + split combined Signatures JSON for every data row.
  if(oldData.length > 0){
    const timestamps = [];
    const sigOperatorVals = [];
    const sigSupervisorVals = [];
    const sigSuperintendentVals = [];
    oldData.forEach(row=>{
      const updatedAt = row[OLD.updatedAt-1];
      const createdAt = row[OLD.createdAt-1];
      timestamps.push([updatedAt || createdAt || ""]);
      let sig = {};
      try{ sig = JSON.parse(row[OLD.signatures-1] || "{}"); }catch(e){ sig = {}; }
      sigOperatorVals.push([sig.operator ? JSON.stringify(sig.operator) : ""]);
      sigSupervisorVals.push([sig.supervisor ? JSON.stringify(sig.supervisor) : ""]);
      sigSuperintendentVals.push([sig.superintendent ? JSON.stringify(sig.superintendent) : ""]);
    });
    db.getRange(2,1,timestamps.length,1).setValues(timestamps);
    db.getRange(2,newSignaturesCol,sigOperatorVals.length,1).setValues(sigOperatorVals);
    db.getRange(2,sigSupervisorCol,sigSupervisorVals.length,1).setValues(sigSupervisorVals);
    db.getRange(2,sigSuperintendentCol,sigSuperintendentVals.length,1).setValues(sigSuperintendentVals);
  }

  SpreadsheetApp.getUi().alert("Migrasi selesai. " + oldData.length + " baris data berhasil dipindahkan ke layout V2 (kolom Timestamp + 3 kolom Signature terpisah).");
}

/* ================= AUTH ================= */

function findUserRow_(username){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USERS_SHEET);
  const last = sh.getLastRow();
  if(last < USERS_FIRST_DATA_ROW) return null;
  const values = sh.getRange(USERS_FIRST_DATA_ROW, 1, last - USERS_FIRST_DATA_ROW + 1, USERS_COLS.shift).getValues();
  for(let i=0;i<values.length;i++){
    if(String(values[i][USERS_COLS.username-1]).trim().toLowerCase() === String(username).trim().toLowerCase()){
      return {rowIndex: USERS_FIRST_DATA_ROW + i, row: values[i], sheet: sh};
    }
  }
  return null;
}

function findUserByToken_(token){
  if(!token) throw new Error("Sesi tidak valid. Silakan login kembali.");
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USERS_SHEET);
  const last = sh.getLastRow();
  if(last < USERS_FIRST_DATA_ROW) throw new Error("Sesi tidak valid.");
  const values = sh.getRange(USERS_FIRST_DATA_ROW, 1, last - USERS_FIRST_DATA_ROW + 1, USERS_COLS.shift).getValues();
  for(let i=0;i<values.length;i++){
    const row = values[i];
    if(String(row[USERS_COLS.token-1]) === String(token)){
      const expiry = row[USERS_COLS.tokenExpiry-1];
      if(expiry && new Date(expiry).getTime() < Date.now()){
        throw new Error("Sesi kadaluarsa. Silakan login kembali.");
      }
      return {
        rowIndex: USERS_FIRST_DATA_ROW + i,
        username: row[USERS_COLS.username-1],
        fullName: row[USERS_COLS.fullName-1],
        jobTitle: row[USERS_COLS.jobTitle-1],
        role: String(row[USERS_COLS.role-1]).trim().toLowerCase(),
        status: row[USERS_COLS.status-1],
        shift: normalizeAssignedShift_(row[USERS_COLS.shift-1])
      };
    }
  }
  throw new Error("Sesi tidak valid. Silakan login kembali.");
}

function actionRegister(body){
  const {username, password, fullName, jobTitle, role} = body;
  if(!username || !password || !fullName || !jobTitle) throw new Error("Data pendaftaran belum lengkap.");
  const existing = findUserRow_(username);
  if(existing) throw new Error("Username sudah terdaftar.");
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USERS_SHEET);
  const newRow = sh.getLastRow() + 1;
  sh.getRange(newRow, USERS_COLS.username).setValue(username);
  // Password is stored AS-IS (no hashing) - on purpose, per request: so an
  // admin/engineer can open the "TATA CARA" sheet and read someone's
  // actual password directly to tell them if they forget it. The Salt
  // column is left blank since it's no longer used for anything.
  sh.getRange(newRow, USERS_COLS.password).setValue(password);
  sh.getRange(newRow, USERS_COLS.fullName).setValue(fullName);
  sh.getRange(newRow, USERS_COLS.jobTitle).setValue(jobTitle);
  sh.getRange(newRow, USERS_COLS.role).setValue((role||"operator").toLowerCase());
  sh.getRange(newRow, USERS_COLS.status).setValue("Pending");
  sh.getRange(newRow, USERS_COLS.createdAt).setValue(new Date());
  return {message:"Pendaftaran berhasil, menunggu persetujuan admin."};
}

function actionLogin(body){
  const {username, password, device} = body;
  const found = findUserRow_(username);
  if(!found) throw new Error("Username atau password salah.");
  const row = found.row;
  // Plain-text comparison - the Password column holds the real password
  // as typed, not a hash (see actionRegister above), so it can be read
  // straight off the sheet if someone forgets it.
  const storedPassword = String(row[USERS_COLS.password-1]);
  if(String(password) !== storedPassword) throw new Error("Username atau password salah.");
  const status = String(row[USERS_COLS.status-1]).trim().toLowerCase();
  if(status === "pending") throw new Error("Akun Anda masih PENDING, menunggu persetujuan admin.");
  if(status === "reject") throw new Error("Akun Anda ditolak oleh admin. Hubungi Engineer/Admin.");
  if(status !== "accept") throw new Error("Status akun tidak valid.");

  const token = Utilities.getUuid();
  const expiry = new Date(Date.now() + TOKEN_LIFETIME_HOURS*3600*1000);
  const sh = found.sheet;
  sh.getRange(found.rowIndex, USERS_COLS.token).setValue(token);
  sh.getRange(found.rowIndex, USERS_COLS.tokenExpiry).setValue(expiry);
  sh.getRange(found.rowIndex, USERS_COLS.lastDevice).setValue(device || "");

  return {
    token: token,
    username: row[USERS_COLS.username-1],
    fullName: row[USERS_COLS.fullName-1],
    jobTitle: row[USERS_COLS.jobTitle-1],
    role: String(row[USERS_COLS.role-1]).trim().toLowerCase(),
    shift: normalizeAssignedShift_(row[USERS_COLS.shift-1])
  };
}


/* ================= ROLE/SHIFT NOTIFICATIONS =================
 * Supervisor and Superintendent receive in-app awareness based on the
 * SHIFT value entered manually in column P ("SHIFT") of "TATA CARA".
 *
 * The active operational shift is determined by the Apps Script timezone:
 *   Pagi  = 07:00-15:00
 *   Siang = 15:00-23:00
 *   Malam = 23:00-07:00
 *
 * For the overnight Malam shift, the operational date is the previous
 * calendar date between 00:00-06:59, so e.g. 2026-10-07 01:00 belongs to
 * Shift Malam tanggal 2026-10-06. This matches the checklist date convention.
 *
 * The expected Group comes from the same 4-group rotation already used by
 * the Demografi sheet. Operators are intentionally NOT restricted by this
 * rule: any operator may fill any shift. The Group schedule is used here to
 * tell Supervisor/Superintendent which Group should have produced the row
 * and to flag a mismatch when another Group actually filled it.
 */
const NOTIFICATION_CHECKLIST_KEYS = ["skimming","tapping","hmc"];

function normalizeAssignedShift_(raw){
  const t = String(raw || "").trim().toLowerCase();
  if(!t) return "";
  if(t === "1" || t === "shift 1") return "Pagi";
  if(t === "2" || t === "shift 2") return "Siang";
  if(t === "3" || t === "shift 3") return "Malam";
  if(t.indexOf("pagi") === 0) return "Pagi";
  if(t.indexOf("siang") === 0) return "Siang";
  if(t.indexOf("malam") === 0) return "Malam";
  if(t.indexOf("15:00") !== -1 && t.indexOf("23:00") !== -1) return "Siang";
  if(t.indexOf("23:00") !== -1 && t.indexOf("07:00") !== -1) return "Malam";
  if(t.indexOf("07:00") !== -1) return "Pagi";
  return "";
}

function currentOperationalShift_(now){
  const tz = Session.getScriptTimeZone();
  const hour = Number(Utilities.formatDate(now, tz, "H"));
  if(hour >= 7 && hour < 15) return "Pagi";
  if(hour >= 15 && hour < 23) return "Siang";
  return "Malam";
}

function currentOperationalDate_(now){
  const tz = Session.getScriptTimeZone();
  const hour = Number(Utilities.formatDate(now, tz, "H"));
  const d = new Date(now.getTime());
  if(hour < 7) d.setDate(d.getDate() - 1);
  return Utilities.formatDate(d, tz, "yyyy-MM-dd");
}

function notificationChecklistTitle_(key){
  const d = CHECKLIST_DATA[key];
  return d && d.title ? d.title : key;
}

function actionGetNotifications(body){
  const user = findUserByToken_(body.token);
  const now = new Date();
  const currentShift = currentOperationalShift_(now);
  const operationalDate = currentOperationalDate_(now);
  const assignedShift = normalizeAssignedShift_(user.shift);
  const tz = Session.getScriptTimeZone();
  const nowText = Utilities.formatDate(now, tz, "yyyy-MM-dd HH:mm:ss");

  // Operator does not use the supervisor/superintendent notification queue.
  if(user.role === "operator"){
    return {
      enabled:false, role:user.role, items:[], count:0,
      assignedShift:assignedShift || null,
      currentShift:currentShift, operationalDate:operationalDate,
      serverTime:nowText
    };
  }

  // Engineer gets an unrestricted view of the current operational shift;
  // Supervisor/Superintendent are filtered by their manually assigned SHIFT.
  if((user.role === "supervisor" || user.role === "superintendent") && !assignedShift){
    return {
      enabled:true, configured:false, role:user.role, items:[], count:0,
      assignedShift:null, currentShift:currentShift,
      operationalDate:operationalDate, serverTime:nowText,
      message:"SHIFT untuk akun ini belum diisi di kolom P (SHIFT) pada sheet TATA CARA."
    };
  }

  if((user.role === "supervisor" || user.role === "superintendent") && assignedShift !== currentShift){
    return {
      enabled:true, configured:true, active:false, role:user.role, items:[], count:0,
      assignedShift:assignedShift, currentShift:currentShift,
      operationalDate:operationalDate, serverTime:nowText,
      message:"Belum masuk jam kerja SHIFT akun ini."
    };
  }

  const targetStatus = user.role === "supervisor" ? "Menunggu Supervisor" :
                       user.role === "superintendent" ? "Menunggu Superintendent" : null;
  const expectedGroup = scheduledGroupForShift_(operationalDate, currentShift);
  const items = [];

  NOTIFICATION_CHECKLIST_KEYS.forEach(key=>{
    const title = notificationChecklistTitle_(key);
    const found = findChecklistRow_(key, operationalDate, currentShift);

    if(!found){
      items.push({
        id:"missing|"+key+"|"+operationalDate+"|"+currentShift,
        type:"missing",
        checklistName:key,
        title:title,
        tanggal:operationalDate,
        shift:currentShift,
        expectedGroup:expectedGroup,
        group:null,
        status:"Belum diisi",
        actionable:false,
        message:title + " belum diisi oleh Group " + (expectedGroup || "?") + "."
      });
      return;
    }

    const rec = rowToRecord_(found.rowIndex, found.row);
    const actualGroup = rec.group || null;
    const groupMismatch = !!(expectedGroup && actualGroup && String(expectedGroup) !== String(actualGroup));

    if(rec.status === targetStatus){
      items.push({
        id:"pending|"+key+"|"+operationalDate+"|"+currentShift+"|"+rec.id,
        type:"pending-signature",
        checklistName:key,
        title:title,
        tanggal:operationalDate,
        shift:currentShift,
        expectedGroup:expectedGroup,
        group:actualGroup,
        status:rec.status,
        actionable:true,
        groupMismatch:groupMismatch,
        message: groupMismatch
          ? title + " menunggu tanda tangan " + (user.role === "supervisor" ? "Supervisor" : "Superintendent") + ". Tercatat Group " + actualGroup + ", seharusnya Group " + expectedGroup + "."
          : title + " menunggu pengecekan & tanda tangan " + (user.role === "supervisor" ? "Supervisor" : "Superintendent") + "."
      });
      return;
    }

    // A row that is still Draft is useful awareness for Supervisor, because
    // it means the expected shift has not yet reached their sign-off stage.
    // For Superintendent, a Draft or Menunggu Supervisor row is also shown
    // as awareness so the person knows the report is not yet ready for them.
    if((user.role === "supervisor" && rec.status === "Draft") ||
       (user.role === "superintendent" && rec.status !== "Final")){
      items.push({
        id:"progress|"+key+"|"+operationalDate+"|"+currentShift+"|"+rec.id,
        type:"progress",
        checklistName:key,
        title:title,
        tanggal:operationalDate,
        shift:currentShift,
        expectedGroup:expectedGroup,
        group:actualGroup,
        status:rec.status,
        actionable:false,
        groupMismatch:groupMismatch,
        message: groupMismatch
          ? title + " berstatus " + rec.status + ", tetapi tercatat Group " + actualGroup + ", seharusnya Group " + expectedGroup + "."
          : title + " masih berstatus " + rec.status + "."
      });
    }
  });

  // Only actionable items count on the bell. Awareness items remain visible
  // in the panel but do not make the notification badge look urgent.
  const actionable = items.filter(x=>x.actionable);
  return {
    enabled:true, configured:true, active:true, role:user.role,
    items:items, count:actionable.length,
    totalItems:items.length,
    assignedShift:assignedShift || null,
    currentShift:currentShift,
    operationalDate:operationalDate,
    expectedGroup:expectedGroup,
    serverTime:nowText
  };
}

/* ================= CHECKLIST DATA ================= */

// PERFORMANCE: every lookup below used to call sh.getRange(...).getValues()
// on its own - a full read of the ENTIRE "Database Checklist" sheet, which
// is a real network round-trip to the Sheets backend, not a free/local
// call. That was fine for a single lookup, but actionGetChecklist's
// resolveGroupForDate_() can walk back up to ~14 previous shifts looking
// for a Group suggestion whenever a shift is opened for the FIRST time
// ever, and EACH step of that walk was re-reading the whole sheet from
// scratch. As "Database Checklist" grows (weeks of 3 shifts x 3
// checklists x however many groups), that compounds into the exact
// symptoms reported: slow loads, and outright "Respon server tidak valid"
// failures once a request's total read time got close to Apps Script's
// execution/response limits.
//
// Fix: read the sheet's data ONCE per web-app request (doPost call) and
// reuse it for every lookup made during that same request via
// getDbRows_() below. Apps Script executions are stateless between
// separate requests (globals reset each time), so this cache can never
// go stale ACROSS requests - it only needs to be invalidated (see
// invalidateDbRowsCache_()) if something WRITES to the sheet partway
// through the SAME request, which only actionSaveOrSubmit/actionSetDraft/
// createEmptyDraftRow_ do.
let _dbRowsCache = null;
function getDbRows_(){
  if(_dbRowsCache) return _dbRowsCache;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DB_SHEET);
  const last = sh.getLastRow();
  _dbRowsCache = (last < 2) ? [] : sh.getRange(2,1,last-1, DB_TOTAL_COLS).getValues();
  return _dbRowsCache;
}
function invalidateDbRowsCache_(){ _dbRowsCache = null; }

// A checklist record is keyed ONLY by checklistName + tanggal + shift -
// Group is just a label field stored INSIDE that one row, not part of the
// lookup key. So there is exactly one row per tanggal/shift no matter
// which Group filled it in.
//
// Defensive: if older data already has more than one row for the same
// tanggal/shift (leftover from before Group was removed from the key, or
// any other duplicate), don't just return whichever comes first - prefer
// a Final row over a Draft one, then the most recently updated/timestamped
// row, so a stray empty duplicate never hides the real data (this was the
// most likely cause of the "signatures don't show up" problem in Form
// Fisik: it was reading a different, signature-less duplicate row).
function findChecklistRow_(checklistName, tanggal, shift){
  const values = getDbRows_();
  let best = null, bestScore = -1;
  for(let i=0;i<values.length;i++){
    const r = values[i];
    if(String(r[DB_COLS.type-1]) === "Checklist" &&
       String(r[DB_COLS.checklistName-1]) === checklistName &&
       formatDate_(r[DB_COLS.tanggal-1]) === tanggal &&
       String(r[DB_COLS.shift-1]) === shift){
      const ts = r[DB_COLS.timestamp-1];
      const t = (ts instanceof Date) ? ts.getTime() : 0;
      const isFinal = String(r[DB_COLS.status-1]) === "Final";
      // Score: Final always beats Draft; within the same status, newer wins.
      const score = (isFinal ? 1e15 : 0) + t;
      if(score > bestScore){
        bestScore = score;
        best = {rowIndex: i+2, row: r, sheet: null}; // sheet handle fetched lazily below only if needed
      }
    }
  }
  return best;
}

// Kept as an alias for readability at call sites that are explicitly
// "I don't care which Group, just give me this shift's row" (Form Fisik,
// previous-shift handover, Group auto-resolve) - it's the exact same
// lookup now that Group is no longer part of the key.
function findChecklistRowAnyGroup_(checklistName, tanggal, shift){
  const f = findChecklistRow_(checklistName, tanggal, shift);
  if(!f) return null;
  return {rowIndex: f.rowIndex, row: f.row, sheet: f.sheet, group: String(f.row[DB_COLS.group-1])};
}

function formatDate_(v){
  if(!v) return "";
  if(v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return String(v).slice(0,10);
}

// Combine the 3 separate signature columns back into the single
// {operator:{name,img}, supervisor:{...}, superintendent:{...}} JSON
// shape the frontend already expects, so index.html needs NO changes
// for the signature feature.
function combineSignatures_(row){
  const out = {};
  ["operator","supervisor","superintendent"].forEach(role=>{
    const colKey = "sig" + role.charAt(0).toUpperCase() + role.slice(1);
    const raw = row[DB_COLS[colKey]-1];
    if(raw){
      try{ out[role] = JSON.parse(raw); }catch(e){ /* ignore corrupt cell */ }
    }
  });
  return JSON.stringify(out);
}

// Split the frontend's combined signatures JSON into the 3 separate
// per-role JSON strings that get written into columns P/Q/R.
function splitSignatures_(signaturesJson){
  let sig = {};
  try{ sig = JSON.parse(signaturesJson || "{}"); }catch(e){ sig = {}; }
  return {
    operator: sig.operator ? JSON.stringify(sig.operator) : "",
    supervisor: sig.supervisor ? JSON.stringify(sig.supervisor) : "",
    superintendent: sig.superintendent ? JSON.stringify(sig.superintendent) : ""
  };
}

function rowToRecord_(rowIndex, row){
  return {
    found: true,
    id: row[DB_COLS.id-1],
    status: row[DB_COLS.status-1],
    // Group is just the label stored on this row - always echoed back so
    // the frontend's Group dropdown reflects whatever was last saved,
    // never used to decide WHICH row this is.
    group: String(row[DB_COLS.group-1] || "") || null,
    dataJson: row[DB_COLS.dataJson-1],
    signatures: combineSignatures_(row),
    createdBy: row[DB_COLS.createdBy-1],
    createdAt: row[DB_COLS.createdAt-1],
    updatedBy: row[DB_COLS.updatedBy-1],
    updatedAt: row[DB_COLS.updatedAt-1],
    finalizedBy: row[DB_COLS.finalizedBy-1],
    finalizedAt: row[DB_COLS.finalizedAt-1]
  };
}

// Pulls out just the 2 pieces of "continuity" info that every role must be
// able to see about a checklist row REGARDLESS of the Final-lock below:
//  - the free-text handover note ("Catatan untuk Shift Berikutnya")
//  - which items were left as X (Abnormal, TIDAK tertangani) along with
//    their catatan text, so the next shift can see what's still an open
//    issue and carry it forward - without exposing the full item-by-item
//    audit trail of a locked previous shift (V/O items stay hidden, only
//    genuinely unresolved X items surface).
function extractContinuityInfo_(dataJsonStr){
  let handover = "", openItems = {};
  try{
    const d = JSON.parse(dataJsonStr || "{}");
    if(d._handover && d._handover.text) handover = d._handover.text;
    Object.keys(d).forEach(k=>{
      if(k === "_handover") return;
      const it = d[k] || {};
      const slot = it.akhir || it.awal || {};
      if(slot.h === "X" && slot.c) openItems[k] = slot.c;
    });
  }catch(e){}
  return {handover, openItems};
}

function actionGetChecklist(body){
  const user = findUserByToken_(body.token);
  const {checklistName, tanggal, shift} = body;
  if(!checklistName || !tanggal || !shift) throw new Error("Tanggal/Shift belum lengkap.");

  // Group is NEVER part of the lookup anymore - there's only ONE row per
  // checklistName+tanggal+shift, whatever Group is written into it. Any
  // `body.group` sent by an OLDER cached frontend is simply ignored on
  // purpose (it used to select a different row; now it can't).
  let found = findChecklistRow_(checklistName, tanggal, shift);

  if(found){
    const continuity = extractContinuityInfo_(found.row[DB_COLS.dataJson-1]);
    // Enforce lock: operator/supervisor cannot see the full data of a
    // Final report - EXCEPT the handover note & open-item carryover
    // above, which every role needs regardless (that's operational
    // continuity, not the audit trail this lock is meant to protect).
    if(found.row[DB_COLS.status-1] === "Final" && (user.role === "operator" || user.role === "supervisor")){
      return {found:true, status:"Final", dataJson:"{}", signatures:"{}", locked:true,
        group: String(found.row[DB_COLS.group-1] || "") || null,
        handover: continuity.handover, openItems: continuity.openItems};
    }
    const rec = rowToRecord_(found.rowIndex, found.row);
    rec.handover = continuity.handover;
    rec.openItems = continuity.openItems;
    return rec;
  }

  // No row yet for this tanggal/shift at all. Suggest a Group purely as a
  // starting default (see resolveGroupForDate_) - whatever Group last
  // worked this shift, or the shift right before it, or the checklist at
  // all, else null on a genuinely brand-new checklist (frontend shows "-"
  // and asks the user to pick one, which is then remembered from then on
  // for THIS SAME tanggal/shift, regardless of Group chosen later).
  const suggestedGroup = resolveGroupForDate_(checklistName, tanggal, shift);

  // AUTO-PROVISION: only when explicitly requested (the main "open
  // checklist" action passes autoProvision:true) - NOT for background/peek
  // lookups such as the previous-shift handover check, so those never
  // create a phantom Draft row for a shift nobody actually opened.
  if(body.autoProvision &&
     (user.role === "operator" || user.role === "supervisor" || user.role === "engineer")){
    createEmptyDraftRow_(checklistName, tanggal, shift, suggestedGroup || "", user);
    found = findChecklistRow_(checklistName, tanggal, shift);
    if(found) return rowToRecord_(found.rowIndex, found.row);
  }
  return {found:false, group: suggestedGroup || null};
}

// Finds whichever Group already has a row for this exact checklist +
// tanggal + shift - returns just the group string, or null if none
// exists yet. (There is only ever one row per tanggal/shift, so this is
// simply that row's Group value.)
function findAnyGroupForShift_(checklistName, tanggal, shift){
  const f = findChecklistRowAnyGroup_(checklistName, tanggal, shift);
  return f ? f.group : null;
}

// Global fallback: the Group used in the MOST RECENTLY updated row for
// this checklist, across every tanggal/shift. Only reached when a shift
// chain walk-back (resolveGroupForDate_) finds nothing at all.
function findLatestGroupForChecklist_(checklistName){
  const values = getDbRows_();
  let bestTime = null, bestGroup = null;
  for(let i=0;i<values.length;i++){
    const r = values[i];
    if(String(r[DB_COLS.type-1]) !== "Checklist" || String(r[DB_COLS.checklistName-1]) !== checklistName) continue;
    const ts = r[DB_COLS.timestamp-1];
    const t = (ts instanceof Date) ? ts.getTime() : null;
    if(t !== null && (bestTime === null || t > bestTime)){
      bestTime = t; bestGroup = String(r[DB_COLS.group-1]);
    }
  }
  return bestGroup;
}

// Same stepping rule as the frontend's prevShiftKey(): Siang->Pagi (same
// day), Malam->Siang (same day), Pagi->Malam of the PREVIOUS day.
function prevShiftKeyGs_(tanggal, shift){
  if(shift === "Siang") return {tanggal: tanggal, shift: "Pagi"};
  if(shift === "Malam") return {tanggal: tanggal, shift: "Siang"};
  const d = new Date(tanggal + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return {tanggal: Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd"), shift: "Malam"};
}

// Resolves which Group to show when none was explicitly requested:
//   1) whoever already has a row for THIS exact shift,
//   2) else walk backwards shift-by-shift (up to ~2 weeks) for the last
//      Group that worked this checklist at all,
//   3) else the most recently used Group for this checklist, any time,
//   4) else null (truly first-ever use - frontend shows "-").
function resolveGroupForDate_(checklistName, tanggal, shift){
  let g = findAnyGroupForShift_(checklistName, tanggal, shift);
  if(g) return g;
  let t = tanggal, s = shift;
  for(let i=0;i<14;i++){
    const prev = prevShiftKeyGs_(t, s);
    g = findAnyGroupForShift_(checklistName, prev.tanggal, prev.shift);
    if(g) return g;
    t = prev.tanggal; s = prev.shift;
  }
  return findLatestGroupForChecklist_(checklistName);
}

function createEmptyDraftRow_(checklistName, tanggal, shift, group, user){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DB_SHEET);
  const now = new Date();
  const id = Utilities.getUuid();
  const newRow = sh.getLastRow() + 1;
  const rowVals = new Array(DB_TOTAL_COLS).fill("");
  rowVals[DB_COLS.timestamp-1] = now;
  rowVals[DB_COLS.id-1] = id;
  rowVals[DB_COLS.type-1] = "Checklist";
  rowVals[DB_COLS.checklistName-1] = checklistName;
  rowVals[DB_COLS.tanggal-1] = tanggal;
  rowVals[DB_COLS.shift-1] = shift;
  rowVals[DB_COLS.group-1] = group;
  rowVals[DB_COLS.dataJson-1] = "{}";
  rowVals[DB_COLS.status-1] = "Draft";
  rowVals[DB_COLS.createdBy-1] = user.fullName;
  rowVals[DB_COLS.createdAt-1] = now;
  rowVals[DB_COLS.updatedBy-1] = user.fullName;
  rowVals[DB_COLS.updatedAt-1] = now;
  sh.getRange(newRow,1,1,DB_TOTAL_COLS).setValues([rowVals]);
  invalidateDbRowsCache_(); // a row was just added - any cached read from earlier in this same request is now stale
}

// Every checklist row moves through these 4 statuses in order:
//   Draft -> Menunggu Supervisor -> Menunggu Superintendent -> Final
// STAGE_RULES describes, for each possible targetStatus, which curStatus
// it must be coming FROM, which role is allowed to trigger that specific
// transition (Engineer can always trigger any of them, as a full
// override), and whose signature must already be present in the payload
// before the transition is allowed. `null` for requiredFrom means "no
// prerequisite" (used by "Draft" itself, since that's also the status a
// brand-new row starts at).
const STAGE_RULES = {
  "Draft":                    {requiredFrom: null,                        role: ["operator","supervisor"], needsSig: null},
  "Menunggu Supervisor":      {requiredFrom: "Draft",                     role: ["operator"],               needsSig: "operator"},
  "Menunggu Superintendent":  {requiredFrom: "Menunggu Supervisor",       role: ["supervisor"],              needsSig: "supervisor"},
  "Final":                    {requiredFrom: "Menunggu Superintendent",   role: ["superintendent"],          needsSig: "superintendent"}
};
// Who's allowed to just SAVE PROGRESS in place (no status change) at
// each status - used by autosave and the signature pads, so e.g. a
// Supervisor can save their in-progress signature without yet triggering
// the "Menunggu Superintendent" transition.
const STAGE_ACTIVE_ROLE_GS = {
  "Draft": ["operator","supervisor"],
  "Menunggu Supervisor": ["supervisor"],
  "Menunggu Superintendent": ["superintendent"],
  "Final": []
};

// targetStatus === null means "in-place save, keep whatever status this
// row is already at" (used for autosave / saving a signature-in-progress
// without advancing the approval chain).
function actionSaveOrSubmit(body, targetStatus){
  const user = findUserByToken_(body.token);
  const {checklistName, tanggal, shift, group, dataJson, signatures} = body;
  if(!checklistName || !tanggal || !shift || !group) throw new Error("Tanggal/Shift/Group belum lengkap.");

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DB_SHEET);
  const existing = findChecklistRow_(checklistName, tanggal, shift);
  const now = new Date();
  const sigSplit = splitSignatures_(signatures);
  const curStatus = existing ? existing.row[DB_COLS.status-1] : "Draft"; // a brand-new row is conceptually "Draft" until first saved

  if(targetStatus){
    // A STAGE TRANSITION (Draft->Menunggu Supervisor->Menunggu Superintendent->Final).
    const rule = STAGE_RULES[targetStatus];
    if(!rule) throw new Error("Status tujuan tidak dikenal: " + targetStatus);
    if(user.role !== "engineer"){
      if(rule.role.indexOf(user.role) === -1){
        throw new Error("Hanya " + rule.role.join(" atau ") + " yang dapat melakukan aksi ini.");
      }
      if(rule.requiredFrom !== null && curStatus !== rule.requiredFrom){
        throw new Error("Laporan harus berstatus '" + rule.requiredFrom + "' terlebih dahulu (status saat ini: '" + curStatus + "').");
      }
      if(targetStatus === "Draft" && curStatus !== "Draft"){
        throw new Error("Laporan sudah dikirim ke tahap berikutnya dan tidak bisa disimpan sebagai Draft lagi. Hubungi Engineer untuk membuka kembali.");
      }
    } else if(rule.requiredFrom !== null && curStatus !== rule.requiredFrom && curStatus !== "Final"){
      // Engineer still follows the stage ORDER (no skipping straight from
      // Draft to Final) to keep the sign-off chain meaningful - they just
      // aren't restricted to their own role. They CAN re-trigger a stage
      // from "Final" (e.g. after fixing a mistake) since that's exactly
      // what revertToDraft + re-submitting is for.
      throw new Error("Laporan harus berstatus '" + rule.requiredFrom + "' terlebih dahulu (status saat ini: '" + curStatus + "').");
    }
    if(rule.needsSig && !sigSplit[rule.needsSig]){
      throw new Error("Tanda tangan " + rule.needsSig + " wajib diisi sebelum melanjutkan ke tahap ini.");
    }
  } else {
    // IN-PLACE SAVE (autosave / saving progress without changing status).
    if(curStatus === "Final" && user.role !== "engineer"){
      throw new Error("Laporan sudah FINAL dan terkunci. Hubungi Engineer untuk membuka kembali.");
    }
    if(user.role !== "engineer" && (STAGE_ACTIVE_ROLE_GS[curStatus] || []).indexOf(user.role) === -1){
      throw new Error("Laporan sedang menunggu tahap lain - Anda tidak dapat menyimpan perubahan sekarang.");
    }
  }
  const finalStatus = targetStatus || curStatus;

  if(existing){
    // Group is just a label on this same row (never a separate row) - it's
    // written on every save/submit just like any other field, so switching
    // the Group dropdown while editing a Draft (or right after an Engineer
    // reverts a Final back to Draft) takes effect next time it's saved.
    sh.getRange(existing.rowIndex, DB_COLS.group).setValue(group);
    sh.getRange(existing.rowIndex, DB_COLS.timestamp).setValue(now);
    sh.getRange(existing.rowIndex, DB_COLS.dataJson).setValue(dataJson);
    sh.getRange(existing.rowIndex, DB_COLS.sigOperator).setValue(sigSplit.operator);
    sh.getRange(existing.rowIndex, DB_COLS.sigSupervisor).setValue(sigSplit.supervisor);
    sh.getRange(existing.rowIndex, DB_COLS.sigSuperintendent).setValue(sigSplit.superintendent);
    sh.getRange(existing.rowIndex, DB_COLS.status).setValue(finalStatus);
    sh.getRange(existing.rowIndex, DB_COLS.updatedBy).setValue(user.fullName);
    sh.getRange(existing.rowIndex, DB_COLS.updatedAt).setValue(now);
    if(finalStatus === "Final"){
      sh.getRange(existing.rowIndex, DB_COLS.finalizedBy).setValue(user.fullName);
      sh.getRange(existing.rowIndex, DB_COLS.finalizedAt).setValue(now);
    }
    const updatedRow = sh.getRange(existing.rowIndex,1,1,DB_TOTAL_COLS).getValues()[0];
    invalidateDbRowsCache_();
    return rowToRecord_(existing.rowIndex, updatedRow);
  } else {
    const id = Utilities.getUuid();
    const newRow = sh.getLastRow() + 1;
    // Always build a FULL-length row (every column, even ones left blank)
    // so setValues() never mismatches the sheet's column count - this was
    // the exact cause of "Gagal menyimpan: Jumlah kolom ... tidak cocok"
    // on the very first Draft save (Final saves happened to fill enough
    // columns to hide the bug).
    const rowVals = new Array(DB_TOTAL_COLS).fill("");
    rowVals[DB_COLS.timestamp-1] = now;
    rowVals[DB_COLS.id-1] = id;
    rowVals[DB_COLS.type-1] = "Checklist";
    rowVals[DB_COLS.checklistName-1] = checklistName;
    rowVals[DB_COLS.tanggal-1] = tanggal;
    rowVals[DB_COLS.shift-1] = shift;
    rowVals[DB_COLS.group-1] = group;
    rowVals[DB_COLS.dataJson-1] = dataJson;
    rowVals[DB_COLS.sigOperator-1] = sigSplit.operator;
    rowVals[DB_COLS.sigSupervisor-1] = sigSplit.supervisor;
    rowVals[DB_COLS.sigSuperintendent-1] = sigSplit.superintendent;
    rowVals[DB_COLS.status-1] = finalStatus;
    rowVals[DB_COLS.createdBy-1] = user.fullName;
    rowVals[DB_COLS.createdAt-1] = now;
    rowVals[DB_COLS.updatedBy-1] = user.fullName;
    rowVals[DB_COLS.updatedAt-1] = now;
    if(finalStatus === "Final"){
      rowVals[DB_COLS.finalizedBy-1] = user.fullName;
      rowVals[DB_COLS.finalizedAt-1] = now;
    }
    sh.getRange(newRow,1,1,DB_TOTAL_COLS).setValues([rowVals]);
    invalidateDbRowsCache_();
    return rowToRecord_(newRow, rowVals);
  }
}

function actionSetDraft(body){
  const user = findUserByToken_(body.token);
  if(user.role !== "engineer") throw new Error("Hanya Engineer yang dapat mengembalikan laporan ke draft.");
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DB_SHEET);
  const values = getDbRows_();
  for(let i=0;i<values.length;i++){
    if(String(values[i][DB_COLS.id-1]) === String(body.id)){
      const rowIndex = i+2;
      const now = new Date();
      sh.getRange(rowIndex, DB_COLS.status).setValue("Draft");
      sh.getRange(rowIndex, DB_COLS.timestamp).setValue(now);
      sh.getRange(rowIndex, DB_COLS.updatedBy).setValue(user.fullName);
      sh.getRange(rowIndex, DB_COLS.updatedAt).setValue(now);
      const updatedRow = sh.getRange(rowIndex,1,1,DB_TOTAL_COLS).getValues()[0];
      invalidateDbRowsCache_();
      return rowToRecord_(rowIndex, updatedRow);
    }
  }
  throw new Error("Data tidak ditemukan.");
}

/* ======================================================================
 * ================= FORM FISIK (sheet preview / print) =================
 * ====================================================================== *
 * Based on the real "Skimming NEW" / "Tapping NEW" / "HMC NEW" sheets you
 * sent: each is a ready-to-print daily form covering all 3 shifts side by
 * side (columns for 07:00-15:00 / 15:00-23:00 / 23:00-07:00), NOT split
 * into "awal/akhir shift" like the web app. Rather than hardcode fragile
 * cell coordinates, the code below AUTO-DETECTS the real layout every
 * time it runs, by reading the actual header text in the template:
 *   - the column holding "Item Pemeriksaan" -> where each item's name is
 *   - the columns holding "07:00 - 15:00" / "15:00 - 23:00" / "23:00 -
 *     07:00" -> the Hasil column for Pagi/Siang/Malam (works even though
 *     HMC's columns are in a different left-to-right order than Skimming/
 *     Tapping - it goes by the text, not a fixed column letter)
 *   - the "Tanda tangan : Operator / Supervisor / Superintendent" blocks
 *     in the rightmost ("Abnormality & Catatan Penanganan") column -> one
 *     signature block per shift, in the same top-to-bottom order as the
 *     3 shifts
 * This means it keeps working even if you tweak the templates later
 * (add/remove items, reorder categories, etc.) as long as those 4 header
 * labels stay the same. Only the SHEET NAME per checklist is fixed below.
 * ---------------------------------------------------------------------
 * One thing intentionally NOT auto-filled: the "Hari/Tanggal :" title
 * block at the top of each template. In your file that label has no
 * clearly separate blank cell reserved for the date (it's baked into a
 * merged/legend cell meant for someone to write on a PRINTED page by
 * hand), so overwriting it risked corrupting your layout. Tanggal/Shift/
 * Group are already shown in the "Form Fisik" input area itself (B3:B5)
 * right above the rendered form - tell me the exact cell if you'd like
 * it mirrored into the template too and I'll wire it up.
 * ---------------------------------------------------------------------
 * Since the template has only ONE Hasil cell per item per shift (not
 * separate awal/akhir like the app), that cell is filled with the
 * app's Akhir-Shift result (falling back to Awal-Shift if Akhir is
 * empty) - i.e. the closing/handover condition. The column immediately
 * to the right (unused/blank in your template's data rows) gets the
 * combined Awal+Akhir catatan text for that item, so nothing recorded
 * in the app is lost even though the printed form only shows 1 result
 * column per shift. */

const FORM_FISIK_SHEET = "Form Fisik";
// Neither Shift nor Group is an input here (per request) - renderFormFisik()
// only ever needs a Tanggal and renders ALL 3 shifts side by side for that
// date, exactly like the real paper form (each item's Hasil lands in
// whichever shift's column actually has data - see findShiftColumns_/
// findChecklistRowAnyGroup_ below). Whichever Group actually worked each
// shift is looked up automatically and is shown only in the status message
// and next to each shift's signatures, never as something you pick here.
const FF_INPUT = { type:"B1", nama:"B2", tanggal:"B3", status:"B4" };
const FF_OUTPUT_START_ROW = 8; // template is pasted starting at this row (leaves B1:B4 inputs + a couple blank rows visible above it)

// Only the sheet name is fixed - everything else (columns, rows, signature
// block positions) is detected automatically from the sheet's own headers.
const FORM_FISIK_CONFIG = {
  skimming: { sheetName: "Skimming NEW" },
  tapping:  { sheetName: "Tapping NEW" },
  hmc:      { sheetName: "HMC NEW" }
};

// Shift labels as actually stored in "Database Checklist" (must match the
// SHIFTS ids used in index.html: Pagi / Siang / Malam - NOT "Sore").
const SHIFTS_GS = ["Pagi","Siang","Malam"];

function normalizeChecklistKey_(nama){
  let t = String(nama||"").trim().toLowerCase();
  t = t.replace(/\bnew\b/g,"").trim();      // "skimming NEW" -> "skimming"
  t = t.replace(/[^a-z0-9]/g,"");           // drop spaces/punctuation
  return t;
}

function normalizeGroup_(raw){
  const n = parseInt(raw, 10);
  if(!isNaN(n)) return String(n);
  return String(raw||"").trim();
}

// Resolves whichever way the checklist was chosen in B2 - a clean title
// ("Skimming"), the exact template sheet name ("Skimming NEW"), or any
// case/spacing variant - to {key, tplSheet}.
function resolveChecklistTemplate_(ss, namaRaw){
  const key = normalizeChecklistKey_(namaRaw);
  let cfg = FORM_FISIK_CONFIG[key];
  if(cfg){
    const tpl = ss.getSheetByName(cfg.sheetName);
    if(tpl) return {key: key, tplSheet: tpl};
  }
  // FIX: normalizeChecklistKey_ just strips spaces/punctuation from
  // whatever's in the dropdown, so a title with parentheses in it - "Hot
  // Metal Crane (HMC)" -> "hotmetalcranehmc" - never matched the "hmc"
  // key, and the sheet-name fallback below also failed because the real
  // sheet is named "HMC NEW", not "Hot Metal Crane (HMC)". Net effect:
  // Form Fisik could NEVER resolve the HMC checklist at all, no matter
  // what - "Skimming"/"Tapping" only ever worked by coincidence (single
  // word, nothing for normalizeChecklistKey_ to mangle). This tries an
  // exact match against each checklist's own display title first, which
  // catches exactly this case.
  const wanted = String(namaRaw||"").trim().toLowerCase();
  if(wanted){
    for(const k in FORM_FISIK_CONFIG){
      const title = CHECKLIST_DATA[k] ? String(CHECKLIST_DATA[k].title||"").trim().toLowerCase() : "";
      if(title && title === wanted){
        const tpl = ss.getSheetByName(FORM_FISIK_CONFIG[k].sheetName);
        if(tpl) return {key: k, tplSheet: tpl};
      }
    }
  }
  const direct = ss.getSheetByName(String(namaRaw||"").trim());
  if(direct){
    for(const k in FORM_FISIK_CONFIG){
      if(FORM_FISIK_CONFIG[k].sheetName === direct.getName()) return {key: k, tplSheet: direct};
    }
  }
  return {key: null, tplSheet: null};
}

// Simple trigger - runs automatically on every manual edit in the
// spreadsheet, no extra authorization/installation needed.
function onEdit(e){
  try{
    if(!e || !e.range) return;
    const sh = e.range.getSheet();
    const a1 = e.range.getA1Notation();

    if(sh.getName() === DEMO_SHEET){
      onEditDemografi_(e);
      return;
    }
    if(sh.getName() !== FORM_FISIK_SHEET) return;

    if(a1 === FF_INPUT.type){
      refreshFormFisikNamaDropdown_(sh);
    }
    if([FF_INPUT.type, FF_INPUT.nama, FF_INPUT.tanggal].indexOf(a1) !== -1){
      renderFormFisik();
    }
  }catch(err){
    try{
      const sh2 = e.range.getSheet();
      const statusCell = sh2.getName() === DEMO_SHEET ? DEMO_INPUT.status : FF_INPUT.status;
      sh2.getRange(statusCell).setValue("Error: " + err.message);
    }catch(e2){}
  }
}

// Re-run this once (from the Apps Script editor) after updating the code
// to drop the now-removed "shift kerja" input row: it clears row 4's old
// label/dropdown and turns it into the status message cell instead.
function setupFormFisikSheet(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(FORM_FISIK_SHEET);
  if(!sh){ sh = ss.insertSheet(FORM_FISIK_SHEET); }

  // Wipe any leftover label/dropdown from the old B4 "shift kerja" input
  // and old B5 status cell before laying out the new A1:A4 shape.
  sh.getRange("A1:B5").clearDataValidations();
  sh.getRange("A4:B5").clearContent();

  sh.getRange("A1").setValue("Checklist atau Record");
  sh.getRange("A2").setValue("Nama Checklist atau Record");
  sh.getRange("A3").setValue("Tanggal");
  sh.getRange("A1:A3").setBackground("#fff2cc");

  sh.getRange(FF_INPUT.type).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(["Checklist","Record"], true).build()
  );
  refreshFormFisikNamaDropdown_(sh);
  sh.getRange(FF_INPUT.status).setFontStyle("italic").setFontColor("#6b7684");
}

function refreshFormFisikNamaDropdown_(sh){
  const type = String(sh.getRange(FF_INPUT.type).getValue()||"Checklist").trim().toLowerCase();
  let list = [];
  if(type === "checklist"){
    list = Object.keys(FORM_FISIK_CONFIG).map(k => CHECKLIST_DATA[k] ? CHECKLIST_DATA[k].title : k);
  } else {
    list = ["(Fitur Record segera hadir)"];
  }
  sh.getRange(FF_INPUT.nama).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(list, true).build()
  );
}

function clearFormFisikOutput_(sh){
  const maxRows = sh.getMaxRows();
  const maxCols = Math.max(sh.getMaxColumns(), 20);
  if(maxRows >= FF_OUTPUT_START_ROW){
    sh.getRange(FF_OUTPUT_START_ROW,1,maxRows-FF_OUTPUT_START_ROW+1,maxCols).clear();
    // clear() alone can leave inserted images behind - remove them too.
    sh.getImages().forEach(img=>{
      if(img.getAnchorCell().getRow() >= FF_OUTPUT_START_ROW) img.remove();
    });
  }
}

function colToIndex_(letter){
  let col = 0;
  const L = String(letter).toUpperCase();
  for(let i=0;i<L.length;i++){ col = col*26 + (L.charCodeAt(i)-64); }
  return col;
}

// Scans the top ~10 rows/columns of a template for a cell whose text
// STARTS WITH `headerText` (case-insensitive) and returns its {row,col}.
function findHeaderCell_(tplSheet, headerText){
  const scanRows = Math.min(tplSheet.getLastRow(), 10);
  const scanCols = Math.min(tplSheet.getLastColumn(), 20);
  const vals = tplSheet.getRange(1,1,scanRows,scanCols).getDisplayValues();
  const needle = headerText.toLowerCase();
  for(let r=0;r<vals.length;r++){
    for(let c=0;c<vals[r].length;c++){
      if(String(vals[r][c]||"").trim().toLowerCase().indexOf(needle) === 0){
        return {row:r+1, col:c+1};
      }
    }
  }
  return null;
}

// Scans the top ~10 rows for the row holding the 3 shift time-range
// labels ("07:00 - 15:00" etc.) and returns {Pagi:col, Siang:col,
// Malam:col} - by TEXT, so it self-corrects even if a template (like
// HMC) lists the shifts in a different left-to-right order.
function findShiftColumns_(tplSheet){
  const scanRows = Math.min(tplSheet.getLastRow(), 10);
  const scanCols = Math.min(tplSheet.getLastColumn(), 20);
  const vals = tplSheet.getRange(1,1,scanRows,scanCols).getDisplayValues();
  const re = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/;
  for(let r=0;r<vals.length;r++){
    const found = {};
    for(let c=0;c<vals[r].length;c++){
      const t = String(vals[r][c]||"").trim();
      const m = t.match(re);
      if(!m) continue;
      const startH = m[1];
      if(startH === "07") found.Pagi = c+1;
      else if(startH === "15") found.Siang = c+1;
      else if(startH === "23") found.Malam = c+1;
    }
    if(Object.keys(found).length >= 2) return found;
  }
  return null;
}

// Finds each CHECKLIST_DATA item's row on the template by matching its
// "item" text down `labelCol`, in order (so repeated names like
// "Kebocoran Oli" are matched to the correct, sequential occurrence).
function findItemRowMap_(tplSheet, key, labelCol, fromRow){
  const items = CHECKLIST_DATA[key].items;
  const lastRow = tplSheet.getLastRow();
  const colVals = tplSheet.getRange(fromRow, labelCol, lastRow-fromRow+1, 1)
    .getDisplayValues().map(r=>String(r[0]||"").trim());
  const map = {};
  let searchFrom = 0;
  items.forEach((it, idx)=>{
    const label = String(it.item||"").trim();
    if(!label) return;
    for(let r=searchFrom; r<colVals.length; r++){
      if(colVals[r] && colVals[r].indexOf(label) !== -1){
        map[idx] = fromRow + r; // 1-based row on the TEMPLATE sheet
        searchFrom = r+1;
        break;
      }
    }
  });
  return map;
}

/* ======================================================================
 * ================= DYNAMIC CHECKLIST DEFINITIONS (read from sheet) ====
 * ====================================================================== *
 * The checklist item list (kategori/pos/item/kode/std) used to live in
 * TWO places that had to be kept in sync by hand: the CHECKLIST_DATA
 * constant up top of this file, and an identical copy inside index.html.
 * Editing "Skimming NEW"/"Tapping NEW"/"HMC NEW" never changed either of
 * those, so the app and Form Fisik kept using the OLD list until someone
 * manually updated the code.
 *
 * getChecklistDefs_() below fixes that: it reads the item list STRAIGHT
 * off each template sheet every time it's called (both from the web
 * app's "getChecklistDefs" action AND from renderFormFisik() itself), so
 * editing a template sheet - add/remove/reorder items, reword a Standar
 * Pemeriksaan, bump the Version label - takes effect everywhere the next
 * time the page/report is opened, with nothing to edit in code.
 *
 * SAFETY NET: if a sheet's layout can't be parsed with confidence (a
 * header got renamed, restructured, whatever), that ONE checklist
 * silently falls back to the CHECKLIST_DATA constant below instead of
 * breaking the app - see getChecklistDefs_(). CHECKLIST_DATA is kept
 * around specifically to be that fallback (and to seed the very first
 * load before any API round-trip), not because it's still the primary
 * source of truth.
 *
 * IMPORTANT CAVEAT (tell the user this): items are matched to already-
 * SAVED answers by their POSITION (1st item, 2nd item, ...), same as
 * before. If you reorder or delete an item in the template sheet, any
 * shift that already saved answers under the OLD order will show up
 * misaligned against the new order for that old data - only going
 * forward is guaranteed consistent. Adding a new item at the END, or
 * only editing wording/std text, is always safe.
 */

// Scans the top rows for any cell whose text, lowercased, is a key in
// `labelMap` - e.g. {"visual":"V","suara":"S","sentuh":"T","bau":"B"} -
// and returns {V:col, S:col, ...} for the FIRST occurrence of each.
function findColsForLabels_(tplSheet, labelMap, scanRows, scanCols){
  const vals = tplSheet.getRange(1,1,scanRows,scanCols).getDisplayValues();
  const out = {};
  for(let r=0;r<vals.length;r++){
    for(let c=0;c<vals[r].length;c++){
      const t = String(vals[r][c]||"").trim().toLowerCase();
      if(labelMap[t] !== undefined && out[labelMap[t]] === undefined) out[labelMap[t]] = c+1;
    }
  }
  return out;
}

// Finds a cell containing "Version : ..." (or "Version: ...") anywhere in
// the top rows and returns the text after the colon.
function findVersionText_(tplSheet, scanRows, scanCols){
  const vals = tplSheet.getRange(1,1,scanRows,scanCols).getDisplayValues();
  for(let r=0;r<vals.length;r++){
    for(let c=0;c<vals[r].length;c++){
      const m = String(vals[r][c]||"").match(/version\s*:\s*(.+)/i);
      if(m) return m[1].trim();
    }
  }
  return "";
}

// Parses ONE template sheet into {title, version, items:[{kat,pos,item,
// kode,std,row}]} (row = that item's actual row on tplSheet, 1-based -
// used by renderFormFisik() so it never needs to text-search for items
// separately; parsing IS the row map). Returns null if the layout can't
// be confidently read (missing "Item Pemeriksaan"/"Standar Pemeriksaan"
// headers, or suspiciously few rows found) - caller falls back to
// CHECKLIST_DATA for that checklist.
function parseChecklistDefinitionFromSheet_(tplSheet, fallbackTitle){
  try{
    const scanRows = Math.min(tplSheet.getLastRow(), 10);
    const scanCols = Math.min(tplSheet.getLastColumn(), 20);
    const itemHeader = findHeaderCell_(tplSheet, "Item Pemeriksaan");
    const stdHeader = findHeaderCell_(tplSheet, "Standar Pemeriksaan");
    if(!itemHeader || !stdHeader) return null;
    const katHeader = findHeaderCell_(tplSheet, "Deskripsi Peralatan");
    const posHeader = findHeaderCell_(tplSheet, "Pos Pemeriksaan");
    const metodeCols = findColsForLabels_(tplSheet, {"visual":"V","suara":"S","sentuh":"T","bau":"B"}, scanRows, scanCols);
    const version = findVersionText_(tplSheet, scanRows, scanCols);

    const fromRow = itemHeader.row + 1;
    const lastRow = tplSheet.getLastRow();
    if(lastRow < fromRow) return null;
    const numRows = lastRow - fromRow + 1;

    const itemCol = itemHeader.col, stdCol = stdHeader.col;
    const katCol = katHeader ? katHeader.col : null;
    const posCol = posHeader ? posHeader.col : null;
    const readCols = [itemCol, stdCol];
    if(katCol) readCols.push(katCol);
    if(posCol) readCols.push(posCol);
    Object.keys(metodeCols).forEach(k=>{ const c = metodeCols[k]; if(readCols.indexOf(c)===-1) readCols.push(c); });
    const minCol = Math.min.apply(null, readCols), maxCol = Math.max.apply(null, readCols);
    const block = tplSheet.getRange(fromRow, minCol, numRows, maxCol-minCol+1).getDisplayValues();
    const at = (row, col) => row[col - minCol];

    let lastKat = "", lastPos = "";
    const items = [];
    for(let r=0;r<numRows;r++){
      const row = block[r];
      const itemTxt = String(at(row, itemCol)||"").trim();
      const stdTxt = String(at(row, stdCol)||"").trim();
      if(!itemTxt) continue; // blank row, category-only row, signature block, footer note, etc.
      // Deskripsi Peralatan / Pos Pemeriksaan are normally vertically
      // MERGED across several item rows on the real sheet - a blank
      // display value on this row just means "same as the row above"
      // (fill-down), not "no category".
      let kat = "", pos = "";
      if(katCol){
        const v = String(at(row, katCol)||"").trim();
        kat = v || lastKat; lastKat = kat;
      }
      if(posCol){
        const v = String(at(row, posCol)||"").trim();
        pos = v || lastPos; lastPos = pos;
      }
      let kode = "";
      Object.keys(metodeCols).forEach(letter=>{
        if(String(at(row, metodeCols[letter])||"").trim()) kode += letter;
      });
      const item = {kat: kat, item: itemTxt, kode: kode || "V", std: stdTxt, row: fromRow + r};
      if(posCol) item.pos = pos;
      items.push(item);
    }
    if(items.length < 3) return null; // too few to trust - treat as a parse failure
    return {title: fallbackTitle, version: version, items: items};
  }catch(e){
    return null;
  }
}

// Builds {skimming:{...}, tapping:{...}, hmc:{...}} fresh from each
// template sheet, falling back to the hardcoded CHECKLIST_DATA per
// checklist when parsing fails. `source` on each entry tells you which
// one you got ("sheet" or "fallback") - surfaced in the Form Fisik status
// message so a parsing problem is visible instead of silent.
function getChecklistDefs_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = {};
  Object.keys(FORM_FISIK_CONFIG).forEach(key=>{
    const cfg = FORM_FISIK_CONFIG[key];
    const fallback = CHECKLIST_DATA[key];
    const tpl = ss.getSheetByName(cfg.sheetName);
    const parsed = tpl ? parseChecklistDefinitionFromSheet_(tpl, fallback ? fallback.title : key) : null;
    const def = parsed || fallback;
    if(def) def.source = parsed ? "sheet" : "fallback";
    out[key] = def;
  });
  return out;
}

// Walks the merged cells in the "Abnormality & Catatan Penanganan"
// column and classifies each block as a "Jam ..." note block (tagged
// with which shift it names) or a "Tanda tangan" signature block
// (tagged with the shift of the note block right above it).
function classifyCatatanColumn_(tplSheet, catCol, fromRow){
  const lastRow = tplSheet.getLastRow();
  const vals = tplSheet.getRange(fromRow, catCol, lastRow-fromRow+1, 1).getDisplayValues();
  const merges = tplSheet.getRange(fromRow, catCol, lastRow-fromRow+1, 1).getMergedRanges();
  function mergeStartingAt(absRow){
    for(let i=0;i<merges.length;i++){ if(merges[i].getRow() === absRow) return merges[i]; }
    return null;
  }
  const blocks = [];
  let r = 0;
  // Row-by-row scan (not merged-ranges-only) because some templates
  // (e.g. "Tapping NEW") use a plain single, UNMERGED cell for the
  // "Jam ..." label while others use a merged block for it - a scan
  // that only looked at merged ranges would silently miss those.
  while(r < vals.length){
    const absRow = fromRow + r;
    const val = String(vals[r][0]||"").trim();
    if(val){
      let endRow = absRow;
      const m = mergeStartingAt(absRow);
      if(m) endRow = m.getRow() + m.getNumRows() - 1;
      let type = null, shift = null;
      if(/tanda\s*tangan/i.test(val)){
        type = "signature";
      } else if(/jam/i.test(val)){
        type = "catatan";
        if(val.indexOf("07:00") !== -1 && val.indexOf("15:00") !== -1) shift = "Pagi";
        else if(val.indexOf("15:00") !== -1 && val.indexOf("23:00") !== -1) shift = "Siang";
        else if(val.indexOf("23:00") !== -1) shift = "Malam";
      }
      if(type) blocks.push({startRow:absRow, endRow:endRow, type:type, shift:shift});
      r = (endRow - fromRow) + 1;
    } else {
      r++;
    }
  }
  let lastShift = null;
  blocks.forEach(b=>{
    if(b.type === "catatan") lastShift = b.shift;
    else if(b.type === "signature") b.shift = lastShift;
  });
  return blocks;
}

// Column-agnostic helper: given a cell, returns the column right after
// whatever it's merged into (or just col+1 if it isn't merged at all).
// Used to find the correct column for a signature image next to a
// label cell ("Operator"/"Supervisor"/"Superintendent") WITHOUT assuming
// that label is exactly 1 column wide - if the template's label cell is
// merged wider than the main "Abnormality" header cell above it (a
// common template-authoring inconsistency), using the header's own
// width would land the image back on top of the label itself instead of
// beside it.
function colAfterMerge_(sheet, row, col){
  const cell = sheet.getRange(row, col);
  const merged = cell.getMergedRanges();
  if(merged && merged.length){
    return merged[0].getLastColumn() + 1;
  }
  return col + 1;
}

function insertSignatureImageAt_(sheet, row, col, dataUrl){
  if(!dataUrl || dataUrl.indexOf("data:image") !== 0) return {ok:false, reason:"kosong (tanda tangan belum diisi)"};
  try{
    const commaIdx = dataUrl.indexOf(",");
    const meta = dataUrl.substring(5, commaIdx);
    const mime = meta.split(";")[0];
    const b64 = dataUrl.substring(commaIdx+1);
    const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, "sig.png");
    const img = sheet.insertImage(blob, col, row);
    // Size the image to fit INSIDE this specific cell - this column's
    // actual width and this row's actual height, minus a small margin -
    // instead of a fixed 90x32px that can spill into the next column/row
    // whenever that cell happens to be narrower/shorter than that.
    const maxW = Math.max(30, sheet.getColumnWidth(col) - 8);
    const maxH = Math.max(18, sheet.getRowHeight(row) - 6);
    img.setWidth(Math.min(90, maxW)).setHeight(Math.min(32, maxH));
    return {ok:true, cell: sheet.getRange(row,col).getA1Notation(), w: Math.min(90,maxW), h: Math.min(32,maxH)};
  }catch(err){
    return {ok:false, reason: String(err && err.message || err)};
  }
}

// Form Fisik is now always ONE block per Tanggal (per the real paper
// form) - Group is no longer a separate physical form. Whichever Group
// actually worked each shift is looked up automatically
// (findChecklistRowAnyGroup_) and its Hasil/Catatan/Tanda-tangan simply
// lands in that shift's own column, side by side in the same sheet -
// exactly like the printed template already lays them out.
function renderFormFisik(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(FORM_FISIK_SHEET);
  if(!sh) throw new Error("Sheet 'Form Fisik' tidak ditemukan. Jalankan setupFormFisikSheet() dahulu.");

  const type = String(sh.getRange(FF_INPUT.type).getValue()||"").trim();
  const namaRaw = String(sh.getRange(FF_INPUT.nama).getValue()||"").trim();
  const tanggalVal = sh.getRange(FF_INPUT.tanggal).getValue();
  // No Shift or Group input to read anymore - the rendered form always
  // shows all 3 shifts side-by-side for this one Tanggal, exactly like the
  // printed template, and fills in whichever shift(s) actually have data.

  clearFormFisikOutput_(sh);

  if(!namaRaw || !tanggalVal){
    sh.getRange(FF_INPUT.status).setValue("Lengkapi Checklist & Tanggal di atas untuk menampilkan form.");
    return;
  }
  if(type.toLowerCase() !== "checklist"){
    sh.getRange(FF_INPUT.status).setValue('Fitur "Record" belum tersedia.');
    return;
  }

  const resolved = resolveChecklistTemplate_(ss, namaRaw);
  if(!resolved.key || !resolved.tplSheet){
    sh.getRange(FF_INPUT.status).setValue('Checklist/sheet template untuk "'+namaRaw+'" tidak ditemukan atau belum dikonfigurasi (lihat FORM_FISIK_CONFIG di Code.gs).');
    return;
  }
  const key = resolved.key;
  const tplSheet = resolved.tplSheet;

  const itemHeader = findHeaderCell_(tplSheet, "Item Pemeriksaan");
  const catHeader = findHeaderCell_(tplSheet, "Abnormality");
  const shiftCols = findShiftColumns_(tplSheet);
  if(!itemHeader || !shiftCols){
    sh.getRange(FF_INPUT.status).setValue('Tidak bisa mendeteksi layout sheet "'+tplSheet.getName()+'" (kolom "Item Pemeriksaan" / jam shift tidak ditemukan). Pastikan header sheet template tidak diubah.');
    return;
  }
  const labelCol = itemHeader.col;
  const fromRow = itemHeader.row + 1;
  // Prefer the fresh parse of THIS exact tplSheet (gives row numbers
  // directly, by construction always in sync with whatever is on the
  // sheet right now) - only fall back to the old "search for the
  // hardcoded item text" approach if that parse fails for some reason.
  const fallbackDef = CHECKLIST_DATA[key];
  const parsedDef = parseChecklistDefinitionFromSheet_(tplSheet, fallbackDef ? fallbackDef.title : key);
  let itemRowMap = {};
  if(parsedDef){
    parsedDef.items.forEach((it,idx)=>{ itemRowMap[idx] = it.row; });
  } else {
    itemRowMap = findItemRowMap_(tplSheet, key, labelCol, fromRow);
  }
  const catBlocks = catHeader ? classifyCatatanColumn_(tplSheet, catHeader.col, fromRow) : [];

  // getDataRange() stops at whatever Sheets considers the "used range" -
  // which can end up one column short of a column someone JUST added
  // (e.g. a new signature column) if that edit only touched formatting/
  // borders right at the edge. Pad a few extra columns past it as a
  // safety margin so a just-added column never silently gets left out of
  // the copy, capped at the sheet's real max so this never errors out.
  const dataRange = tplSheet.getDataRange();
  const numRows = dataRange.getNumRows();
  const numCols = Math.min(tplSheet.getMaxColumns(), dataRange.getNumColumns() + 3);
  const tplRange = tplSheet.getRange(1, 1, numRows, numCols);
  const tanggal = formatDate_(tanggalVal);

  const blockStartRow = FF_OUTPUT_START_ROW;
  tplRange.copyTo(sh.getRange(blockStartRow,1,numRows,numCols));
  const rowOffset = blockStartRow - 1;

  // Whichever Group worked each shift, looked up automatically - NOT
  // fixed to a chosen Group anymore.
  const recByShift = {}, groupByShift = {};
  SHIFTS_GS.forEach(s=>{
    const f = findChecklistRowAnyGroup_(key, tanggal, s);
    recByShift[s] = f ? rowToRecord_(f.rowIndex, f.row) : null;
    groupByShift[s] = f ? f.group : null;
  });
  const anyDataFound = !!(recByShift.Pagi || recByShift.Siang || recByShift.Malam);

  // Fill Hasil (+ catatan in the column right next to it) per item, per shift.
  Object.keys(itemRowMap).forEach(idxStr=>{
    const tplRow = itemRowMap[idxStr];
    const outRow = tplRow + rowOffset;
    SHIFTS_GS.forEach(s=>{
      const col = shiftCols[s];
      const rec = recByShift[s];
      if(!col || !rec) return;
      let saved = {};
      try{ saved = JSON.parse(rec.dataJson || "{}"); }catch(e){}
      const it = saved[idxStr] || {};
      const awal = it.awal || {}, akhir = it.akhir || {};
      const hasil = akhir.h || awal.h || "";
      sh.getRange(outRow, col).setValue(hasil);
      const notesParts = [];
      if(awal.c) notesParts.push("Awal: "+awal.c);
      if(akhir.c) notesParts.push("Akhir: "+akhir.c);
      const noteCol = col+1;
      const isNoteColSafeToUse = Object.values(shiftCols).indexOf(noteCol) === -1;
      if(notesParts.length && isNoteColSafeToUse){
        sh.getRange(outRow, noteCol).setValue(notesParts.join(" / "));
      }
    });
  });

  // Signatures: on the real templates, each "Tanda tangan :" label is
  // followed IMMEDIATELY by 3 rows - Operator / Supervisor / Superintendent
  // (in that fixed order), all still in the SAME column as the labels
  // themselves. The signature image must go in the CELL RIGHT NEXT TO each
  // of those 3 label rows - which shift's signatures land in which block
  // is already known from classifyCatatanColumn_'s b.shift tagging.
  //
  // The target column is worked out fresh for EACH label row via
  // colAfterMerge_() (not just once from the header) because a label cell
  // ("Operator" etc.) can be merged wider than the "Abnormality..." header
  // cell above it - using the header's width alone would land the image
  // back on top of the label.
  //
  // Every possible stopping point below is logged into sigDebug - not just
  // outright insertImage() errors - because the previous version only
  // reported failures from the LAST step (the actual insertImage call) and
  // stayed completely silent if something upstream (header not found, no
  // "Tanda tangan" block detected, or a block whose shift couldn't be
  // determined) skipped the whole thing before ever reaching that call.
  // That silent-upstream-skip is exactly what produced "no error shown,
  // but also no image at all".
  const sigDebug = [];
  let sigInserted = 0, sigExpected = 0;
  if(!catHeader){
    sigDebug.push('Kolom "Abnormality & Catatan Penanganan" tidak ditemukan di sheet template "'+tplSheet.getName()+'" (dicari di 10 baris x 20 kolom pertama) - tanda tangan tidak bisa disisipkan sama sekali.');
  } else if(!catBlocks.some(b=>b.type==="signature")){
    sigDebug.push('Label "Tanda tangan :" tidak terdeteksi di kolom '+String.fromCharCode(64+catHeader.col)+' pada sheet template "'+tplSheet.getName()+'" - cek ejaan persis label itu di sheet template.');
  } else {
    catBlocks.forEach(b=>{
      if(b.type !== "signature") return;
      if(!b.shift){
        sigDebug.push('Blok "Tanda tangan :" di baris template '+b.startRow+' tidak bisa dikaitkan ke shift manapun (label "Jam ..." di atasnya tidak terbaca/tidak ada) - dilewati.');
        return;
      }
      const rec = recByShift[b.shift];
      if(!rec) return; // no data at all for that shift - not a signature-specific problem
      let sigs = {};
      try{ sigs = JSON.parse(rec.signatures || "{}"); }catch(e){}
      ["operator","supervisor","superintendent"].forEach((role,i)=>{
        sigExpected++;
        const s = sigs[role];
        const labelRow = b.startRow + 1 + i; // +1 Operator, +2 Supervisor, +3 Superintendent (template coords)
        const sigCol = colAfterMerge_(tplSheet, labelRow, catHeader.col);
        const targetRow = labelRow + rowOffset;
        if(s && s.img){
          const res = insertSignatureImageAt_(sh, targetRow, sigCol, s.img);
          if(res.ok){ sigInserted++; sigDebug.push(`${role} (${b.shift}): OK di ${res.cell} (${res.w}x${res.h}px)`); }
          else sigDebug.push(`${role} (${b.shift}): gagal di baris ${targetRow} kol ${sigCol} - ${res.reason}`);
        } else {
          sigDebug.push(`${role} (${b.shift}): belum ada tanda tangan di data tersimpan untuk shift ini.`);
        }
      });
    });
  }

  // Handover notes ("Catatan untuk Shift Berikutnya") typed in the web app
  // - appended right below the copied block's own static "Note:"
  // instruction line (never overwriting it), one line per shift that has one.
  const handoverLines = [];
  SHIFTS_GS.forEach(s=>{
    const rec = recByShift[s];
    if(!rec) return;
    let saved = {};
    try{ saved = JSON.parse(rec.dataJson || "{}"); }catch(e){}
    if(saved._handover && saved._handover.text){
      handoverLines.push("Shift " + s + ": " + saved._handover.text);
    }
  });
  if(handoverLines.length){
    let noteRow = blockStartRow + numRows + 1;
    sh.getRange(noteRow, 2).setValue("Catatan dari Aplikasi (Serah Terima Shift):").setFontWeight("bold");
    sh.getRange(noteRow + 1, 2, handoverLines.length, 1).setValues(handoverLines.map(t=>[t]));
  }

  if(!anyDataFound){
    sh.getRange(FF_INPUT.status).setValue("Belum ada data untuk Tanggal " + tanggal + ".");
  } else {
    const groupNote = SHIFTS_GS.map(s => s + ": Group " + (groupByShift[s] || "-")).join(" | ");
    let msg = "Data dimuat untuk " + tanggal + " (" + groupNote + ").";
    msg += ` Tanda tangan: ${sigInserted}/${sigExpected} berhasil disisipkan.`;
    msg += parsedDef ? ` Item checklist: dibaca langsung dari sheet "${tplSheet.getName()}" (${parsedDef.items.length} item).` : ` ⚠️ Item checklist: memakai cadangan lama di Code.gs (gagal membaca dari sheet "${tplSheet.getName()}" - cek header kolomnya).`;
    if(sigDebug.length){
      msg += " Detail: " + sigDebug.join(" | ");
    }
    sh.getRange(FF_INPUT.status).setValue(msg);
  }
}

// Custom menu - gives a way to re-run renderFormFisik() with FULL script
// authorization (unlike the onEdit auto-refresh below, which runs as a
// restricted "simple trigger" and can occasionally be blocked from doing
// things like inserting images). If signatures ever fail to appear via
// the normal auto-refresh, use this menu item instead.
function onOpen(e){
  SpreadsheetApp.getUi()
    .createMenu("Checklist Furnace")
    .addItem("Render Ulang Form Fisik", "menuRenderFormFisik")
    .addItem("Setup Ulang Sheet Form Fisik", "setupFormFisikSheet")
    .addSeparator()
    .addItem("Render Ulang Demografi", "menuRenderDemografi")
    .addItem("Setup Ulang Sheet Demografi", "setupDemografiSheet")
    .addToUi();
}
function menuRenderFormFisik(){
  renderFormFisik();
  SpreadsheetApp.getUi().alert("Form Fisik sudah dirender ulang. Lihat pesan status di sel " + FF_INPUT.status + ".");
}
function menuRenderDemografi(){
  renderDemografi();
  SpreadsheetApp.getUi().alert("Demografi sudah dirender ulang. Lihat pesan status di sel " + DEMO_INPUT.status + ".");
}

/* ======================================================================
 * ================= DEMOGRAFI (laporan checklist yang belum lengkap) ===
 * ====================================================================== *
 * A "who hasn't filled this in yet" compliance report. Given a date
 * range, lists EVERY Tanggal + Shift + Checklist combination in that
 * range - always telling you which Group SHOULD have filled it in, using
 * the shift rotation schedule below - and its completion status: no
 * Draft started at all, a Draft missing one or more of the 3 signatures,
 * a Final report that's somehow still missing a signature, or fully done
 * (Final + all 3 signatures). Fully-done rows are shaded light green so
 * gaps still stand out at a glance, without hiding the complete ones.
 * ---------------------------------------------------------------------
 * SHIFT ROTATION SCHEDULE
 * 4 groups, cycling Off -> Pagi -> Siang -> Malam -> Off -> ... , 2 days
 * per phase (8-day full cycle). Anchored to the pattern you gave:
 *   2026-09-08 (and 09-09): Group 3 = Pagi, Group 4 = Siang,
 *                           Group 1 = Malam, Group 2 = Off
 *   2026-09-10 (and 09-11): Group 2 = Pagi, Group 3 = Siang,
 *                           Group 4 = Malam, Group 1 = Off
 *   ...and so on, both forwards and backwards from that anchor date -
 *   the math below works for ANY date, not just ones after 2026-09-08.
 * If this rotation is ever changed on the ground, update
 * SHIFT_SCHEDULE_ANCHOR_DATE / SHIFT_SCHEDULE_ANCHOR_PHASE below to
 * match a new known anchor date and everything downstream keeps working. */

const SHIFT_SCHEDULE_ANCHOR_DATE = "2026-09-08";
// phase 0=Pagi, 1=Siang, 2=Malam, 3=Off - this is each Group's phase ON
// the anchor date above.
const SHIFT_SCHEDULE_ANCHOR_PHASE = {"1":2, "2":3, "3":0, "4":1};
const SHIFT_PHASE_LABELS = ["Pagi","Siang","Malam","Off"];

// Pure calendar-day difference between two 'yyyy-MM-dd' strings, done via
// UTC-midnight parsing on BOTH sides so it's immune to local/script
// timezone drift (same class of bug as the frontend's date-arithmetic fix
// elsewhere in this project - see prevShiftKey() in index.html).
function daysBetween_(fromStr, toStr){
  const a = new Date(fromStr + "T00:00:00Z");
  const b = new Date(toStr + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Returns which Group ("1".."4") is scheduled to work `shiftLabel`
// ("Pagi"/"Siang"/"Malam") on `dateStr` - or null for a shift label that
// doesn't exist (there's always exactly one Group working each of the 3
// real shifts; "Off" is never asked for here since the caller only loops
// over SHIFTS_GS).
function scheduledGroupForShift_(dateStr, shiftLabel){
  const days = daysBetween_(SHIFT_SCHEDULE_ANCHOR_DATE, dateStr);
  const cycle = (((Math.floor(days/2)) % 4) + 4) % 4; // 0..3, wraps correctly for dates BEFORE the anchor too
  for(const g in SHIFT_SCHEDULE_ANCHOR_PHASE){
    const phase = (SHIFT_SCHEDULE_ANCHOR_PHASE[g] + cycle) % 4;
    if(SHIFT_PHASE_LABELS[phase] === shiftLabel) return g;
  }
  return null;
}

const DEMO_SHEET = "Demografi";
const DEMO_INPUT = { start:"B1", end:"B2", status:"B3" };
const DEMO_OUTPUT_START_ROW = 6;
const DEMO_MAX_DAYS = 62; // safety cap so a huge range can't time out the script

function setupDemografiSheet(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(DEMO_SHEET);
  if(!sh){ sh = ss.insertSheet(DEMO_SHEET); }
  sh.getRange("A1:B3").clearDataValidations();
  sh.getRange("A1").setValue("Tanggal Mulai");
  sh.getRange("A2").setValue("Tanggal Selesai");
  sh.getRange("A1:A2").setBackground("#fff2cc");
  sh.getRange(DEMO_INPUT.start).setNumberFormat("yyyy-mm-dd");
  sh.getRange(DEMO_INPUT.end).setNumberFormat("yyyy-mm-dd");
  sh.getRange(DEMO_INPUT.status).setFontStyle("italic").setFontColor("#6b7684");
}

function clearDemografiOutput_(sh){
  const maxRows = sh.getMaxRows();
  const maxCols = Math.max(sh.getMaxColumns(), 10);
  if(maxRows >= DEMO_OUTPUT_START_ROW){
    sh.getRange(DEMO_OUTPUT_START_ROW,1,maxRows-DEMO_OUTPUT_START_ROW+1,maxCols).clear();
  }
}

// Same simple trigger pattern as Form Fisik - runs on every manual edit,
// only reacts when it's the Demografi sheet's own B1/B2 date inputs.
function onEditDemografi_(e){
  if(!e || !e.range) return;
  const sh = e.range.getSheet();
  if(sh.getName() !== DEMO_SHEET) return;
  const a1 = e.range.getA1Notation();
  if([DEMO_INPUT.start, DEMO_INPUT.end].indexOf(a1) !== -1){
    renderDemografi();
  }
}

function renderDemografi(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(DEMO_SHEET);
  if(!sh) throw new Error("Sheet 'Demografi' tidak ditemukan. Jalankan setupDemografiSheet() dahulu.");

  clearDemografiOutput_(sh);

  const startVal = sh.getRange(DEMO_INPUT.start).getValue();
  const endVal = sh.getRange(DEMO_INPUT.end).getValue();
  if(!startVal || !endVal){
    sh.getRange(DEMO_INPUT.status).setValue("Isi Tanggal Mulai & Tanggal Selesai di atas untuk menampilkan laporan.");
    return;
  }
  const startStr = formatDate_(startVal);
  const endStr = formatDate_(endVal);
  const totalDays = daysBetween_(startStr, endStr) + 1;
  if(totalDays < 1){
    sh.getRange(DEMO_INPUT.status).setValue("Tanggal Selesai harus sama atau setelah Tanggal Mulai.");
    return;
  }
  if(totalDays > DEMO_MAX_DAYS){
    sh.getRange(DEMO_INPUT.status).setValue("Rentang tanggal terlalu panjang (" + totalDays + " hari, maksimal " + DEMO_MAX_DAYS + "). Persempit rentangnya.");
    return;
  }

  const header = ["Tanggal","Shift","Checklist","Group Seharusnya","Status","Keterangan"];
  sh.getRange(DEMO_OUTPUT_START_ROW,1,1,header.length).setValues([header]).setFontWeight("bold");
  sh.setFrozenRows(DEMO_OUTPUT_START_ROW);

  const checklistKeys = Object.keys(FORM_FISIK_CONFIG); // ["skimming","tapping","hmc"]
  const rowsOut = [];
  const bgColors = []; // parallel array - one row of colors per rowsOut row
  const COLOR_COMPLETE = "#d9ead3"; // light green
  const COLOR_GAP = null; // leave default (white) for anything not complete
  let completeCount = 0;

  for(let d=0; d<totalDays; d++){
    const dt = new Date(startStr + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() + d);
    const dateStr = Utilities.formatDate(dt, "UTC", "yyyy-MM-dd");

    SHIFTS_GS.forEach(shift=>{
      const scheduledGroup = scheduledGroupForShift_(dateStr, shift);
      checklistKeys.forEach(key=>{
        const title = CHECKLIST_DATA[key] ? CHECKLIST_DATA[key].title : key;
        const found = findChecklistRow_(key, dateStr, shift);
        let status, ket, isComplete = false;
        if(!found){
          status = "Belum diisi sama sekali";
          ket = "Belum ada Draft dibuat.";
        } else {
          const rec = rowToRecord_(found.rowIndex, found.row);
          let sigs = {};
          try{ sigs = JSON.parse(rec.signatures || "{}"); }catch(e){}
          const signedCount = ["operator","supervisor","superintendent"].filter(r => sigs[r] && sigs[r].img).length;
          const groupMismatch = rec.group && scheduledGroup && String(rec.group) !== String(scheduledGroup);
          const mismatchNote = groupMismatch ? (" (tercatat oleh Group " + rec.group + ", seharusnya Group " + scheduledGroup + " - mohon dicek)") : "";
          if(rec.status === "Final" && signedCount === 3){
            isComplete = true;
            status = "Selesai - Final & 3/3 tanda tangan";
            ket = "Lengkap." + mismatchNote;
          } else if(rec.status === "Final"){
            status = "FINAL tapi tanda tangan tidak lengkap (" + signedCount + "/3)";
            ket = "Sudah dikirim Final tapi ada tanda tangan yang kosong." + mismatchNote;
          } else {
            // rec.status here is one of: "Draft", "Menunggu Supervisor",
            // "Menunggu Superintendent" - shown as-is so it's clear
            // exactly which stage of the tiered sign-off it's stuck at.
            status = rec.status + " - " + signedCount + "/3 tanda tangan";
            ket = (signedCount === 0 ? "Belum ada tanda tangan sama sekali." : "Tanda tangan belum lengkap.") + mismatchNote;
          }
        }
        rowsOut.push([dateStr, shift, title, "Group " + (scheduledGroup||"?"), status, ket]);
        const rowColor = isComplete ? COLOR_COMPLETE : COLOR_GAP;
        bgColors.push(header.map(()=>rowColor));
        if(isComplete) completeCount++;
      });
    });
  }

  if(rowsOut.length){
    const outRange = sh.getRange(DEMO_OUTPUT_START_ROW+1,1,rowsOut.length,header.length);
    outRange.setValues(rowsOut);
    outRange.setBackgrounds(bgColors);
  }
  sh.autoResizeColumns(1, header.length);

  const totalChecked = totalDays * SHIFTS_GS.length * checklistKeys.length;
  const gapCount = rowsOut.length - completeCount;
  sh.getRange(DEMO_INPUT.status).setValue(
    "Tanggal " + startStr + " s/d " + endStr + " (" + totalDays + " hari): " +
    totalChecked + " kombinasi Tanggal+Shift+Checklist ditampilkan - " +
    gapCount + " BELUM lengkap, " + completeCount + " sudah selesai (hijau)."
  );
}

