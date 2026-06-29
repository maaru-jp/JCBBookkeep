/**
 * 刷卡紀錄 · Google 試算表後端
 *
 * 結構：一個試算表、每家銀行一個分頁（工作表）
 * - 富邦銀行
 * - 玉山銀行
 * - _帳單繳費（各月是否已繳卡費，選用）
 *
 * 使用方式：
 * 1. 前往 https://sheets.google.com 建立新試算表
 * 2. 延伸功能 → Apps Script，貼上此檔全部內容
 * 3. 執行 initializeSpreadsheet（首次會要求授權）
 * 4. （選用）部署 → 新增部署 → 網路應用程式，取得 URL 供前端同步
 */

/** @typedef {{ id: string, name: string, closingDay: (number|null) }} BankConfig */

/** 銀行設定（與 js/app.js 的 BANKS 對應） */
const BANKS = [
  { id: "fubon", name: "富邦銀行", closingDay: 22 },
  { id: "esun", name: "玉山銀行", closingDay: 15 },
];

/** 各銀行分頁欄位（A 欄為內部紀錄 ID，請勿刪除） */
const RECORD_HEADERS = [
  "紀錄ID",
  "帳單月份",
  "帳單已繳卡費",
  "明細對帳",
  "包裹單號",
  "商品名稱",
  "商品日幣小計(¥)",
  "運費(¥)",
  "消費稅(10%)(¥)",
  "亞馬遜積分抵扣(¥)",
  "平台優惠券抵扣(¥)",
  "日幣合計(¥)",
  "台幣金額(NT$)",
  "匯率(台/日)",
  "刷卡日期",
  "備註",
];

const SETTLEMENT_SHEET = "_帳單繳費";
const SETTLEMENT_HEADERS = ["銀行ID", "銀行名稱", "帳單月份", "已繳卡費", "繳費日期"];

// ─── 選單 ─────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("刷卡紀錄")
    .addItem("初始化試算表（建立各銀行分頁）", "initializeSpreadsheet")
    .addItem("插入範例資料", "insertSampleData")
    .addSeparator()
    .addItem("匯出全部 JSON", "showAllRecordsJson")
    .addToUi();
}

// ─── 初始化 ───────────────────────────────────────────

/** 建立各銀行分頁與標題列（可重複執行，不會刪除既有資料列） */
function initializeSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  BANKS.forEach(function (bank) {
    ensureRecordSheet_(ss, bank.name);
  });

  ensureSettlementSheet_(ss);

  SpreadsheetApp.getUi().alert(
    "完成",
    "已建立分頁：\n" +
      BANKS.map(function (b) {
        return "• " + b.name;
      }).join("\n") +
      "\n\n以及「" +
      SETTLEMENT_SHEET +
      "」繳費狀態表。",
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/** @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss @param {string} name */
function ensureRecordSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS]);
    formatHeaderRow_(sheet, RECORD_HEADERS.length);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 120);
  } else {
    const firstRow = sheet.getRange(1, 1, 1, RECORD_HEADERS.length).getValues()[0];
    if (firstRow[0] !== RECORD_HEADERS[0]) {
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS]);
      formatHeaderRow_(sheet, RECORD_HEADERS.length);
      sheet.setFrozenRows(1);
    }
  }
}

/** @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss */
function ensureSettlementSheet_(ss) {
  let sheet = ss.getSheetByName(SETTLEMENT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTLEMENT_SHEET);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SETTLEMENT_HEADERS.length).setValues([SETTLEMENT_HEADERS]);
    formatHeaderRow_(sheet, SETTLEMENT_HEADERS.length);
    sheet.setFrozenRows(1);
  }
}

/** @param {GoogleAppsScript.Spreadsheet.Sheet} sheet @param {number} cols */
function formatHeaderRow_(sheet, cols) {
  sheet.getRange(1, 1, 1, cols).setFontWeight("bold").setBackground("#eef1ff");
}

// ─── 讀寫紀錄 ─────────────────────────────────────────

/** @param {string} bankId */
function getBankConfig_(bankId) {
  const bank = BANKS.filter(function (b) {
    return b.id === bankId;
  })[0];
  if (!bank) throw new Error("未知銀行：" + bankId);
  return bank;
}

/** @param {string} bankId @returns {Object[]} */
function getRecordsByBank(bankId) {
  const bank = getBankConfig_(bankId);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(bank.name);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const values = sheet.getRange(2, 1, sheet.getLastRow(), RECORD_HEADERS.length).getValues();
  return values
    .filter(function (row) {
      return row[0] || row[4];
    })
    .map(function (row) {
      return rowToRecord_(bank.id, row);
    });
}

/** @returns {Object[]} 全部銀行紀錄 */
function getAllRecords() {
  return BANKS.reduce(function (all, bank) {
    return all.concat(getRecordsByBank(bank.id));
  }, []);
}

/** @param {string} bankId @param {Object} record */
function appendRecord(bankId, record) {
  const bank = getBankConfig_(bankId);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(bank.name);
  if (!sheet) throw new Error("找不到分頁：" + bank.name);

  const id = record.id || Utilities.getUuid();
  const row = recordToRow_(Object.assign({}, record, { id: id, bankId: bankId }));
  sheet.appendRow(row);
  return id;
}

/** @param {string} bankId @param {string} recordId @param {Object} updates */
function updateRecord(bankId, recordId, updates) {
  const bank = getBankConfig_(bankId);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(bank.name);
  if (!sheet) throw new Error("找不到分頁：" + bank.name);

  const rowIndex = findRecordRowIndex_(sheet, recordId);
  if (rowIndex < 0) throw new Error("找不到紀錄：" + recordId);

  const existing = rowToRecord_(bankId, sheet.getRange(rowIndex, 1, 1, RECORD_HEADERS.length).getValues()[0]);
  const merged = Object.assign({}, existing, updates, { id: recordId, bankId: bankId });
  sheet.getRange(rowIndex, 1, 1, RECORD_HEADERS.length).setValues([recordToRow_(merged)]);
}

/** @param {string} bankId @param {string} recordId */
function deleteRecord(bankId, recordId) {
  const bank = getBankConfig_(bankId);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(bank.name);
  if (!sheet) return;

  const rowIndex = findRecordRowIndex_(sheet, recordId);
  if (rowIndex > 0) sheet.deleteRow(rowIndex);
}

/** 以試算表為準，整批覆寫某銀行分頁（保留標題列） */
function replaceBankRecords(bankId, records) {
  const bank = getBankConfig_(bankId);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureRecordSheet_(ss, bank.name);
  const sheet = ss.getSheetByName(bank.name);

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }

  if (!records || !records.length) return;

  const rows = records.map(function (r) {
    return recordToRow_(Object.assign({}, r, { bankId: bankId, id: r.id || Utilities.getUuid() }));
  });
  sheet.getRange(2, 1, 1 + rows.length, RECORD_HEADERS.length).setValues(rows);
}

/** @param {GoogleAppsScript.Spreadsheet.Sheet} sheet @param {string} recordId */
function findRecordRowIndex_(sheet, recordId) {
  if (sheet.getLastRow() < 2) return -1;
  const ids = sheet.getRange(2, 1, sheet.getLastRow(), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(recordId)) return i + 2;
  }
  return -1;
}

/** @param {Object} record @returns {*[]} */
function recordToRow_(record) {
  const rate =
    record.amountJpy && record.amountTwd
      ? (Number(record.amountTwd) / Number(record.amountJpy)).toFixed(4)
      : record.rate || "";

  return [
    record.id || "",
    record.billMonth || "",
    record.billPaid ? "是" : settlementPaid_(record.bankId, record.billMonth) ? "是" : "否",
    record.reconciled ? "已對帳" : "待對帳",
    record.packageNo || "",
    formatProducts_(record.products) || record.productsText || "",
    numOrBlank_(record.productsSubtotalJpy),
    numOrBlank_(record.shippingJpy),
    numOrBlank_(record.consumptionTaxJpy),
    numOrBlank_(record.amazonPointsJpy),
    numOrBlank_(record.couponJpy),
    numOrBlank_(record.amountJpy),
    numOrBlank_(record.amountTwd),
    rate,
    record.payDate || "",
    record.note || "",
  ];
}

/** @param {string} bankId @param {*[]} row @returns {Object} */
function rowToRecord_(bankId, row) {
  if (row.length >= 16) {
    return {
      id: String(row[0] || ""),
      bankId: bankId,
      billMonth: String(row[1] || ""),
      billPaid: row[2] === "是",
      reconciled: row[3] === "已對帳",
      packageNo: String(row[4] || ""),
      productsText: String(row[5] || ""),
      productsSubtotalJpy: toNum_(row[6]),
      shippingJpy: toNum_(row[7]),
      consumptionTaxJpy: toNum_(row[8]),
      amazonPointsJpy: toNum_(row[9]),
      couponJpy: toNum_(row[10]),
      amountJpy: toNum_(row[11]),
      amountTwd: toNum_(row[12]),
      payDate: formatDateCell_(row[14]),
      note: String(row[15] || ""),
    };
  }

  if (row.length >= 15) {
    return {
      id: String(row[0] || ""),
      bankId: bankId,
      billMonth: String(row[1] || ""),
      billPaid: row[2] === "是",
      reconciled: row[3] === "已對帳",
      packageNo: String(row[4] || ""),
      productsText: String(row[5] || ""),
      productsSubtotalJpy: toNum_(row[6]),
      shippingJpy: toNum_(row[7]),
      consumptionTaxJpy: 0,
      amazonPointsJpy: toNum_(row[8]),
      couponJpy: toNum_(row[9]),
      amountJpy: toNum_(row[10]),
      amountTwd: toNum_(row[11]),
      payDate: formatDateCell_(row[13]),
      note: String(row[14] || ""),
    };
  }

  return {
    id: String(row[0] || ""),
    bankId: bankId,
    billMonth: String(row[1] || ""),
    billPaid: row[2] === "是",
    reconciled: row[3] === "已對帳",
    packageNo: String(row[4] || ""),
    productsText: String(row[5] || ""),
    productsSubtotalJpy: toNum_(row[6]),
    shippingJpy: 0,
    consumptionTaxJpy: 0,
    amazonPointsJpy: toNum_(row[7]),
    couponJpy: toNum_(row[8]),
    amountJpy: toNum_(row[9]),
    amountTwd: toNum_(row[10]),
    payDate: formatDateCell_(row[12]),
    note: String(row[13] || ""),
  };
}

/** @param {Object[]|undefined} products */
function formatProducts_(products) {
  if (!products || !products.length) return "";
  return products
    .map(function (p) {
      const qty = p.quantity > 1 ? "×" + p.quantity : "";
      return p.name + qty + "(¥" + p.amountJpy + ")";
    })
    .join("、");
}

function numOrBlank_(n) {
  if (n === null || n === undefined || n === "") return "";
  return Number(n) || 0;
}

function toNum_(v) {
  if (v === "" || v === null || v === undefined) return 0;
  return Math.round(Number(v)) || 0;
}

/** @param {*} v */
function formatDateCell_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(v || "");
}

/** @returns {Object[]} */
function getAllSettlements() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTLEMENT_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const data = sheet.getRange(2, 1, sheet.getLastRow(), SETTLEMENT_HEADERS.length).getValues();
  return data
    .filter(function (row) {
      return row[0] && row[2];
    })
    .map(function (row) {
      return {
        bankId: String(row[0]),
        billMonth: String(row[2]),
        paid: row[3] === "是",
        paidDate: formatDateCell_(row[4]),
      };
    });
}

// ─── 帳單繳費狀態 ─────────────────────────────────────

/** @param {string} bankId @param {string} billMonth */
function settlementPaid_(bankId, billMonth) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTLEMENT_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return false;

  const data = sheet.getRange(2, 1, sheet.getLastRow(), SETTLEMENT_HEADERS.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === bankId && data[i][2] === billMonth) {
      return data[i][3] === "是";
    }
  }
  return false;
}

/** @param {string} bankId @param {string} billMonth @param {boolean} paid @param {string=} paidDate */
function setSettlement(bankId, billMonth, paid, paidDate) {
  const bank = getBankConfig_(bankId);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSettlementSheet_(ss);
  const sheet = ss.getSheetByName(SETTLEMENT_SHEET);

  const data = sheet.getLastRow() >= 2 ? sheet.getRange(2, 1, sheet.getLastRow(), 5).getValues() : [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === bankId && data[i][2] === billMonth) {
      sheet.getRange(i + 2, 4, 1, 2).setValues([[paid ? "是" : "否", paidDate || ""]]);
      return;
    }
  }
  sheet.appendRow([bankId, bank.name, billMonth, paid ? "是" : "否", paidDate || ""]);
}

// ─── 範例資料 ─────────────────────────────────────────

function insertSampleData() {
  initializeSpreadsheet();

  replaceBankRecords("fubon", [
    {
      id: Utilities.getUuid(),
      billMonth: "2025-05",
      reconciled: false,
      packageNo: "TW123456789",
      productsText: "無線耳機(¥5980)",
      productsSubtotalJpy: 5980,
      shippingJpy: 0,
      consumptionTaxJpy: 0,
      amountJpy: 5980,
      payDate: "2025-05-08",
      note: "帳單未到先記日幣",
    },
    {
      id: Utilities.getUuid(),
      billMonth: "2025-05",
      reconciled: true,
      packageNo: "TW987654321",
      productsText: "保護殼(¥1280)、螢幕保護貼(¥890)",
      productsSubtotalJpy: 2170,
      amazonPointsJpy: 200,
      amountJpy: 1970,
      amountTwd: 412,
      payDate: "2025-05-15",
    },
  ]);

  replaceBankRecords("esun", [
    {
      id: Utilities.getUuid(),
      billMonth: "2025-05",
      reconciled: false,
      packageNo: "TW111222333",
      productsText: "鍵盤(¥8500)",
      productsSubtotalJpy: 8500,
      shippingJpy: 550,
      consumptionTaxJpy: 770,
      amazonPointsJpy: 500,
      couponJpy: 300,
      amountJpy: 9020,
      payDate: "2025-05-10",
      note: "玉山 15 日結帳",
    },
  ]);

  setSettlement("fubon", "2025-04", true, "2025-05-10");
  setSettlement("esun", "2025-04", true, "2025-05-08");

  SpreadsheetApp.getUi().alert("已插入富邦、玉山範例資料。");
}

function showAllRecordsJson() {
  const json = JSON.stringify({ records: getAllRecords() }, null, 2);
  Logger.log(json);
  SpreadsheetApp.getUi().alert("JSON 已寫入「執行紀錄」(檢視 → 執行紀錄)。");
}

// ─── Web App API（部署後供前端 fetch）────────────────

/**
 * GET ?action=all | ?action=bank&bankId=fubon
 * 回傳 JSON
 */
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const result = handleApi_(params);
  if (params.callback) {
    return ContentService.createTextOutput(params.callback + "(" + JSON.stringify(result) + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonResponse_(result);
}

/** POST body: JSON { action, bankId, records, record, settlements } */
function doPost(e) {
  try {
    const body = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    return jsonResponse_(handleApi_(body));
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

/** @param {Object} params */
function handleApi_(params) {
  const action = params.action || "all";

  if (action === "all") {
    return { ok: true, records: getAllRecords(), settlements: getAllSettlements(), banks: BANKS };
  }

  if (action === "bank") {
    return { ok: true, records: getRecordsByBank(params.bankId) };
  }

  if (action === "replaceBank") {
    replaceBankRecords(params.bankId, params.records || []);
    return { ok: true, count: (params.records || []).length };
  }

  if (action === "append") {
    const id = appendRecord(params.bankId, params.record || {});
    return { ok: true, id: id };
  }

  if (action === "update") {
    updateRecord(params.bankId, params.recordId, params.record || {});
    return { ok: true };
  }

  if (action === "delete") {
    deleteRecord(params.bankId, params.recordId);
    return { ok: true };
  }

  if (action === "setSettlement") {
    setSettlement(params.bankId, params.billMonth, params.paid === true || params.paid === "true", params.paidDate || "");
    return { ok: true };
  }

  if (action === "syncAll") {
    (params.records || []).forEach(function (group) {
      if (group.bankId && group.records) {
        replaceBankRecords(group.bankId, group.records);
      }
    });
    (params.settlements || []).forEach(function (s) {
      setSettlement(s.bankId, s.billMonth, s.paid, s.paidDate);
    });
    return { ok: true };
  }

  return { ok: false, error: "未知 action：" + action };
}

/** @param {Object} obj */
function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
