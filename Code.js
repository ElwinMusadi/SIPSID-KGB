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
      data.signNama,          // Kolom X: Nama Penandatangan
      data.signPangkat,       // Kolom Y: Pangkat Penandatangan
      data.signNip            // Kolom Z: NIP Penandatangan
    ]);
    
    return ContentService.createTextOutput(JSON.stringify({"status": "success"}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch(error) {
    return ContentService.createTextOutput(JSON.stringify({"status": "error", "message": error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}