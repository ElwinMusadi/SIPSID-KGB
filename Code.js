function doGet(e) {
  var template = HtmlService.createTemplateFromFile('Index');
  
  var serverPayload = {
    status: "success",
    users: [],
    gajiPNS: [],
    gajiPPPK: [],
    errorMsg: ""
  };
  
  try {
    var ss = SpreadsheetApp.openById("1ZwZRVDmgYivLL5NpcwA0OixR2iN6yioQs38J4ftEAvY");
    
    // 1. Baca Data User
    var sheetUser = ss.getSheetByName("Master_User");
    if(sheetUser) {
      var userValues = sheetUser.getDataRange().getValues();
      for (var i = 1; i < userValues.length; i++) {
        if(userValues[i][0]) {
          serverPayload.users.push({
            username: String(userValues[i][0]).trim(),
            password: String(userValues[i][1]).trim(),
            namaLengkap: String(userValues[i][2]).trim(),
            hakAkses: String(userValues[i][3]).trim()
          });
        }
      }
    }
    
    // 2. Baca data gaji dari tabel silang Master_Gaji_Pangkat.
    var salaryPayload = readMasterGaji_();
    if (salaryPayload.status !== "success") {
      throw new Error(salaryPayload.errorMsg);
    }
    serverPayload.gajiPNS = salaryPayload.gajiPNS;
    serverPayload.gajiPPPK = salaryPayload.gajiPPPK;
  } catch(e) {
    serverPayload.status = "error";
    serverPayload.errorMsg = e.toString();
  }
  
  // Suntikkan data sebagai JSON yang aman untuk konteks <script> di template HTML.
  template.serverData = JSON.stringify(serverPayload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  
  return template.evaluate()
    .setTitle('SIPSID-KGB NTT')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getMasterGaji() {
  return readMasterGaji_();
}

function readMasterGaji_() {
  var result = {
    status: "success",
    gajiPNS: [],
    gajiPPPK: [],
    errorMsg: ""
  };

  try {
    var ss = SpreadsheetApp.openById("1ZwZRVDmgYivLL5NpcwA0OixR2iN6yioQs38J4ftEAvY");
    var sheetGaji = ss.getSheetByName("Master_Gaji_Pangkat");
    if (!sheetGaji) {
      throw new Error("Sheet Master_Gaji_Pangkat tidak ditemukan.");
    }

    var gajiRange = sheetGaji.getDataRange();
    var gajiValues = gajiRange.getValues();
    var gajiDisplayValues = gajiRange.getDisplayValues();
    var headers = gajiDisplayValues[0] || [];

    for (var i = 1; i < gajiValues.length; i++) {
      var row = gajiValues[i];
      var displayRow = gajiDisplayValues[i];
      var statusPegawai = String(displayRow[0]).trim().toUpperCase();
      var pangkat = String(displayRow[1]).trim();

      if ((statusPegawai !== "PNS" && statusPegawai !== "PPPK") || !pangkat) {
        continue;
      }

      for (var j = 2; j < headers.length; j++) {
        var headerMatch = String(headers[j]).match(/MKG\s*(\d+)\s*Tahun/i);
        if (!headerMatch) continue;

        var nominal = normalizeNominalGaji_(row[j], displayRow[j]);
        if (nominal === null || nominal === "0") continue;

        var salaryItem = {
          mkg: Number(headerMatch[1]),
          pangkat: pangkat,
          nominal: nominal
        };

        if (statusPegawai === "PNS") {
          result.gajiPNS.push(salaryItem);
        } else {
          result.gajiPPPK.push(salaryItem);
        }
      }
    }
  } catch (error) {
    result.status = "error";
    result.errorMsg = error.toString();
  }

  return result;
}

function normalizeNominalGaji_(rawValue, displayValue) {
  if (typeof rawValue === "number" && isFinite(rawValue)) {
    return String(rawValue);
  }

  var nominalText = String(displayValue || rawValue || "").trim();
  if (!nominalText) return null;

  var digitsOnly = nominalText.replace(/[^0-9]/g, "");
  return digitsOnly || null;
}

function getArsipSurat(request) {
  if (request && request.action === "delete") {
    return deleteArsipSurat_(request.id);
  }

  var result = {
    status: "success",
    data: [],
    errorMsg: ""
  };

  try {
    var ss = SpreadsheetApp.openById("1ZwZRVDmgYivLL5NpcwA0OixR2iN6yioQs38J4ftEAvY");
    var sheet = ss.getSheetByName("Database_Surat");
    if (!sheet) {
      throw new Error("Sheet Database_Surat tidak ditemukan.");
    }

    var rows = sheet.getDataRange().getDisplayValues();
    for (var i = rows.length - 1; i >= 1; i--) {
      var row = rows[i];
      if (!String(row[1] || "").trim()) continue;

      result.data.push({
        id: String(row[1] || "").trim(),
        statusPegawai: String(row[2] || "").trim(),
        nama: String(row[3] || "").trim(),
        nip: String(row[4] || "").trim(),
        pangkat: String(row[5] || "").trim(),
        jabatan: String(row[6] || "").trim(),
        unit: String(row[7] || "").trim(),
        kabkot: String(row[8] || "").trim(),
        skPejabat: String(row[9] || "").trim(),
        skTanggal: normalizeDateForClient_(row[10]),
        skNomor: String(row[11] || "").trim(),
        skTmt: normalizeDateForClient_(row[12]),
        mkLamaThn: String(row[13] || "0").trim(),
        mkLamaBln: String(row[14] || "0").trim(),
        gajiLama: String(row[15] || "").trim(),
        mkBaruThn: String(row[16] || "0").trim(),
        mkBaruBln: String(row[17] || "0").trim(),
        gajiBaruTmt: normalizeDateForClient_(row[18]),
        gajiBaru: String(row[19] || "").trim(),
        suratNomor: String(row[20] || "").trim(),
        suratTanggal: normalizeDateForClient_(row[21]),
        signJabatan: String(row[22] || "").trim(),
        signNama: String(row[23] || "").trim(),
        signPangkat: String(row[24] || "").trim(),
        signNip: String(row[25] || "").trim(),
        ukuranKertas: String(row[26] || "legal").trim().toLowerCase() || "legal"
      });
    }
  } catch (error) {
    result.status = "error";
    result.errorMsg = error.toString();
  }

  return result;
}

function deleteArsipSurat_(id) {
  var recordId = String(id || "").trim();
  if (!recordId) {
    return { status: "error", errorMsg: "ID surat tidak valid." };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    var ss = SpreadsheetApp.openById("1ZwZRVDmgYivLL5NpcwA0OixR2iN6yioQs38J4ftEAvY");
    var sheet = ss.getSheetByName("Database_Surat");
    if (!sheet) {
      throw new Error("Sheet Database_Surat tidak ditemukan.");
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return { status: "not_found", errorMsg: "Data surat tidak ditemukan." };
    }

    var ids = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0] || "").trim() === recordId) {
        sheet.deleteRow(i + 2);
        SpreadsheetApp.flush();
        return { status: "success", id: recordId };
      }
    }

    return { status: "not_found", errorMsg: "Data surat tidak ditemukan atau sudah dihapus." };
  } catch (error) {
    return { status: "error", errorMsg: error.toString() };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function normalizeDateForClient_(value) {
  var text = String(value || "").trim();
  if (!text) return "";

  var isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[1] + "-" + isoMatch[2] + "-" + isoMatch[3];

  var localMatch = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (localMatch) {
    return localMatch[3] + "-" + String(localMatch[2]).padStart(2, "0") + "-" + String(localMatch[1]).padStart(2, "0");
  }

  return text;
}

function doPost(e) {
  try {
    var ss = SpreadsheetApp.openById("1ZwZRVDmgYivLL5NpcwA0OixR2iN6yioQs38J4ftEAvY");
    var sheet = ss.getSheetByName("Database_Surat");
    
    // Parse data JSON yang dikirimkan oleh fetch() dari frontend
    var data = JSON.parse(e.postData.contents);
    
    // Pastikan susunan appendRow ini sesuai urutan Kolom A hingga Z di Spreadsheet 'Database_Surat'
    sheet.appendRow([
      new Date(),             // Kolom A: Timestamp (Otomatis)
      data.id,                // Kolom B: ID Surat
      data.statusPegawai,     // Kolom C: Status Pegawai
      data.nama,              // Kolom D: Nama Lengkap
      data.nip,               // Kolom E: NIP / NI PPPK
      data.pangkat,           // Kolom F: Pangkat / Golongan
      data.jabatan,           // Kolom G: Jabatan
      data.unit,              // Kolom H: Unit Kerja / Sekolah
      data.kabkot,            // Kolom I: Kabupaten / Kota
      data.skPejabat,         // Kolom J: Pejabat Penetap SK Terakhir
      data.skTanggal,         // Kolom K: Tanggal SK Terakhir
      data.skNomor,           // Kolom L: Nomor SK Terakhir
      data.skTmt,             // Kolom M: TMT Gaji Lama
      data.mkLamaThn,         // Kolom N: Masa Kerja Lama (Tahun)
      data.mkLamaBln,         // Kolom O: Masa Kerja Lama (Bulan)
      data.gajiLama,          // Kolom P: Gaji Pokok Lama
      data.mkBaruThn,         // Kolom Q: Masa Kerja Baru (Tahun)
      data.mkBaruBln,         // Kolom R: Masa Kerja Baru (Bulan)
      data.gajiBaruTmt,       // Kolom S: TMT Gaji Baru
      data.gajiBaru,          // Kolom T: Gaji Pokok Baru
      data.suratNomor,        // Kolom U: Nomor Surat KGB
      data.suratTanggal,      // Kolom V: Tanggal Pembuatan Surat
      data.signJabatan,       // Kolom W: Jabatan Penandatangan
      data.signNama,            // Kolom X: Nama Penandatangan
      data.signPangkat,         // Kolom Y: Pangkat Penandatangan
      data.signNip,             // Kolom Z: NIP Penandatangan
      data.ukuranKertas || "legal" // Kolom AA: Ukuran Kertas
    ]);
    
    return ContentService.createTextOutput(JSON.stringify({"status": "success"}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch(error) {
    return ContentService.createTextOutput(JSON.stringify({"status": "error", "message": error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}