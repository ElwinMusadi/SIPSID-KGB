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
    
    // 2. Baca Data Gaji (Tarik Angka Saja, Persis Sesuai Sheet Master_Gaji_Pangkat Tanpa Modifikasi/Pembulatan)
    var sheetGaji = ss.getSheetByName("Master_Gaji_Pangkat");
    if(sheetGaji) {
      var gajiValues = sheetGaji.getDataRange().getValues();
      for (var j = 1; j < gajiValues.length; j++) {
        var row = gajiValues[j];
        var statusPegawai = String(row[0]).trim().toUpperCase();
        var masaKerja = parseInt(row[1]) || 0;
        var pangkat = String(row[2]).trim();
        
        // Ambil nilai nominal mentah dari kolom index 3 (D) dan pastikan berupa angka murni
        var rawNominal = row[3];
        var nominalNum = 0;
        
        if (typeof rawNominal === 'number') {
          nominalNum = rawNominal;
        } else if (typeof rawNominal === 'string') {
          // Bersihkan string dari simbol mata uang, titik, atau koma desimal ekstra jika ada
          var cleanStr = rawNominal.replace(/[^0-9]/g, '');
          nominalNum = parseInt(cleanStr) || 0;
        }
        
        if (statusPegawai === "PNS") {
          serverPayload.gajiPNS.push({ mkg: masaKerja, pangkat: pangkat, nominal: String(nominalNum) });
        } else if (statusPegawai === "PPPK") {
          serverPayload.gajiPPPK.push({ mkg: masaKerja, pangkat: pangkat, nominal: String(nominalNum) });
        }
      }
    }
  } catch(e) {
    serverPayload.status = "error";
    serverPayload.errorMsg = e.toString();
  }
  
  // Suntikkan data secara aman ke HTML
  template.serverData = JSON.stringify(serverPayload);
  
  return template.evaluate()
    .setTitle('SIPSID-KGB NTT')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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