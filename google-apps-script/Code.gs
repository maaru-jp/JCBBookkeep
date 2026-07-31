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

// ─── 欄位對應（以標題列為準，相容舊版欄位數）─────────

/**
 * 標題文字 → 內部欄位鍵。
 * 用關鍵字比對，因此舊版標題（沒有運費／消費稅欄）也能正確對應，
 * 不會因為欄位數不同而整列錯位。
 * @param {*} title
 */
function headerKey_(title) {
  const t = String(title || "").replace(/\s/g, "");
  if (!t) return "";
  if (t.indexOf("紀錄ID") >= 0 || t === "ID") return "id";
  if (t.indexOf("月份") >= 0) return "billMonth";
  if (t.indexOf("已繳") >= 0) return "billPaid";
  if (t.indexOf("對帳") >= 0) return "reconciled";
  if (t.indexOf("包裹") >= 0) return "packageNo";
  if (t.indexOf("商品名稱") >= 0) return "products";
  if (t.indexOf("小計") >= 0) return "productsSubtotalJpy";
  if (t.indexOf("運費") >= 0) return "shippingJpy";
  if (t.indexOf("消費稅") >= 0) return "consumptionTaxJpy";
  if (t.indexOf("積分") >= 0) return "amazonPointsJpy";
  if (t.indexOf("優惠券") >= 0) return "couponJpy";
  if (t.indexOf("日幣合計") >= 0) return "amountJpy";
  if (t.indexOf("台幣") >= 0) return "amountTwd";
  if (t.indexOf("匯率") >= 0) return "rate";
  if (t.indexOf("日期") >= 0) return "payDate";
  if (t.indexOf("備註") >= 0) return "note";
  return "";
}

/** @param {*[]} header @returns {Object} 欄位鍵 → 0-based 欄索引 */
function buildHeaderMap_(header) {
  const map = {};
  for (var i = 0; i < header.length; i++) {
    const key = headerKey_(header[i]);
    if (key && map[key] === undefined) map[key] = i;
  }
  return map;
}

/** 目前版本的欄位對應 */
const CURRENT_HEADER_MAP = buildHeaderMap_(RECORD_HEADERS);

/** @param {*[]} header 標題列是否已是目前版本 */
function isCurrentHeader_(header) {
  for (var i = 0; i < RECORD_HEADERS.length; i++) {
    const actual = String(header[i] || "").replace(/\s/g, "");
    if (actual !== RECORD_HEADERS[i].replace(/\s/g, "")) return false;
  }
  return true;
}

/** @param {Object} map @param {*[]} row 該列是否有實際內容 */
function rowHasContent_(map, row) {
  const keys = ["id", "packageNo", "products"];
  for (var i = 0; i < keys.length; i++) {
    const idx = map[keys[i]];
    if (idx !== undefined && String(row[idx] || "").trim() !== "") return true;
  }
  return false;
}

// ─── 選單 ─────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("刷卡紀錄")
    .addItem("初始化試算表（建立各銀行分頁）", "initializeSpreadsheet")
    .addItem("修正欄位錯位（重新對齊）", "repairAllSheets")
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

  ensureColumnCount_(sheet);

  if (sheet.getLastRow() === 0) {
    writeHeaderRow_(sheet);
  } else {
    upgradeRecordSheet_(sheet);
  }

  ensureMonthColumnText_(sheet, CURRENT_HEADER_MAP.billMonth + 1);
  return sheet;
}

/** 分頁欄數不足時補足，避免讀寫超出範圍 */
function ensureColumnCount_(sheet) {
  const missing = RECORD_HEADERS.length - sheet.getMaxColumns();
  if (missing > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), missing);
}

/** @param {GoogleAppsScript.Spreadsheet.Sheet} sheet */
function writeHeaderRow_(sheet) {
  sheet.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS]);
  formatHeaderRow_(sheet, RECORD_HEADERS.length);
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 120);
}

/**
 * 舊版標題（欄位較少）會讓每一列往左錯位，金額欄讀到日期。
 * 這裡先依「舊標題列」把資料正確解讀，再依目前欄位順序整批寫回。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function upgradeRecordSheet_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = Math.min(Math.max(sheet.getLastColumn(), 1), sheet.getMaxColumns());
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = buildHeaderMap_(header);

  // 找不到可辨識的標題 → 第 1 列可能是資料，補回標題列
  if (map.id === undefined && map.packageNo === undefined) {
    sheet.insertRowBefore(1);
    writeHeaderRow_(sheet);
    return;
  }

  if (isCurrentHeader_(header)) return;

  const dataRows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  const records = dataRows
    .filter(function (row) {
      return rowHasContent_(map, row);
    })
    .map(function (row) {
      return rowToRecord_("", row, map);
    });

  // 有資料卻一筆都認不出來 → 對應可能有誤，寧可不動也不要清空
  if (dataRows.length && !records.length) {
    throw new Error("「" + sheet.getName() + "」的標題列無法對應欄位，已中止以免清空資料。");
  }

  writeHeaderRow_(sheet);
  writeRecordRows_(
    sheet,
    records.map(function (r) {
      return recordToRow_(Object.assign({}, r, { id: r.id || Utilities.getUuid() }));
    })
  );
  trimRowsAfter_(sheet, 1 + records.length);
}

/**
 * 先覆寫再刪除多餘列。
 * 若先刪除再寫入，中途出錯就會只剩標題列（資料全失）。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet @param {*[][]} rows
 */
function writeRecordRows_(sheet, rows) {
  if (!rows.length) return;
  ensureRowCapacity_(sheet, 1 + rows.length);
  // 先鎖成文字，避免 2026-07 被試算表判定成日期
  sheet.getRange(2, CURRENT_HEADER_MAP.billMonth + 1, rows.length, 1).setNumberFormat("@");
  sheet.getRange(2, 1, rows.length, RECORD_HEADERS.length).setValues(rows);
}

/** 分頁列數不足時補足，避免 setValues 超出範圍而中斷 */
function ensureRowCapacity_(sheet, needed) {
  const missing = needed - sheet.getMaxRows();
  if (missing > 0) sheet.insertRowsAfter(sheet.getMaxRows(), missing);
}

/** @param {GoogleAppsScript.Spreadsheet.Sheet} sheet @param {number} keepRows 保留的列數（含標題列） */
function trimRowsAfter_(sheet, keepRows) {
  const lastRow = sheet.getLastRow();
  if (lastRow > keepRows) sheet.deleteRows(keepRows + 1, lastRow - keepRows);
}

/**
 * 修復用：依標題列重新對齊所有分頁的欄位。
 * 舊版分頁欄位較少時，金額欄會讀到日期（出現上兆的台幣金額），執行此項即可修正。
 */
function repairAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const backups = [];

  // 動手前先各留一份備份分頁
  BANKS.forEach(function (bank) {
    const sheet = ss.getSheetByName(bank.name);
    if (sheet && sheet.getLastRow() > 1) backups.push(backupSheet_(sheet).getName());
  });

  BANKS.forEach(function (bank) {
    ensureRecordSheet_(ss, bank.name);
  });
  ensureSettlementSheet_(ss);

  SpreadsheetApp.getUi().alert(
    "已重新對齊欄位",
    "各銀行分頁已改為目前欄位順序。\n請回到網頁按「從雲端載入」重新讀取。" +
      (backups.length ? "\n\n已建立備份分頁：\n• " + backups.join("\n• ") : ""),
    SpreadsheetApp.getUi().ButtonSet.OK
  );
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

  ensureMonthColumnText_(sheet, 3);
}

/**
 * 帳單月份欄固定為純文字，避免 2026-07 被試算表判定成日期；
 * 同時把先前已被轉成日期的儲存格改回 yyyy-MM。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet @param {number} col
 */
function ensureMonthColumnText_(sheet, col) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setNumberFormat("@");
    return;
  }

  const range = sheet.getRange(2, col, lastRow - 1, 1);
  const fixed = range.getValues().map(function (row) {
    return [row[0] === "" ? "" : formatMonthCell_(row[0])];
  });
  range.setNumberFormat("@").setValues(fixed);
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

  const lastCol = Math.min(Math.max(sheet.getLastColumn(), 1), sheet.getMaxColumns());
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const parsed = buildHeaderMap_(header);
  const map = Object.keys(parsed).length ? parsed : CURRENT_HEADER_MAP;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  return values
    .filter(function (row) {
      return rowHasContent_(map, row);
    })
    .map(function (row) {
      return rowToRecord_(bank.id, row, map);
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
  const sheet = ensureRecordSheet_(SpreadsheetApp.getActiveSpreadsheet(), bank.name);

  const id = record.id || Utilities.getUuid();
  const row = recordToRow_(Object.assign({}, record, { id: id, bankId: bankId }));
  sheet.appendRow(row);
  return id;
}

/** @param {string} bankId @param {string} recordId @param {Object} updates */
function updateRecord(bankId, recordId, updates) {
  const bank = getBankConfig_(bankId);
  const sheet = ensureRecordSheet_(SpreadsheetApp.getActiveSpreadsheet(), bank.name);

  const rowIndex = findRecordRowIndex_(sheet, recordId);
  if (rowIndex < 0) throw new Error("找不到紀錄：" + recordId);

  const existing = rowToRecord_(
    bankId,
    sheet.getRange(rowIndex, 1, 1, RECORD_HEADERS.length).getValues()[0],
    CURRENT_HEADER_MAP
  );
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
  const sheet = ensureRecordSheet_(ss, bank.name);

  const rows = (records || []).map(function (r) {
    return recordToRow_(Object.assign({}, r, { bankId: bankId, id: r.id || Utilities.getUuid() }));
  });

  // 遠端要求清空、但分頁內有資料時先備份，避免同步失誤直接抹掉整個分頁
  if (!rows.length && sheet.getLastRow() > 1) {
    backupSheet_(sheet);
  }

  writeRecordRows_(sheet, rows);
  trimRowsAfter_(sheet, 1 + rows.length);
}

/**
 * 把分頁複製成一份備份分頁（同一份試算表內）。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function backupSheet_(sheet) {
  const ss = sheet.getParent();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  const copy = sheet.copyTo(ss);
  copy.setName(("_備份 " + sheet.getName() + " " + stamp).slice(0, 100));
  return copy;
}

/** @param {GoogleAppsScript.Spreadsheet.Sheet} sheet @param {string} recordId */
function findRecordRowIndex_(sheet, recordId) {
  if (sheet.getLastRow() < 2) return -1;
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
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

  const billMonth = formatMonthCell_(record.billMonth);

  return [
    record.id || "",
    billMonth,
    record.billPaid ? "是" : settlementPaid_(record.bankId, billMonth) ? "是" : "否",
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
    formatDateCell_(record.payDate),
    record.note || "",
  ];
}

/**
 * 依標題對應把整列轉成紀錄物件。
 * 用欄位名稱而非固定位置，舊版分頁（欄位較少）也不會錯位。
 * @param {string} bankId @param {*[]} row @param {Object} [map] @returns {Object}
 */
function rowToRecord_(bankId, row, map) {
  const m = map || CURRENT_HEADER_MAP;

  function cell(key) {
    const idx = m[key];
    return idx === undefined ? "" : row[idx];
  }

  const twdCell = cell("amountTwd");
  let payDate = formatDateCell_(cell("payDate"));

  // 舊資料錯位時，金額欄可能實際存的是刷卡日期：救回日期、金額歸零
  if (!payDate && twdCell instanceof Date) {
    payDate = formatDateCell_(twdCell);
  }

  return {
    id: String(cell("id") || ""),
    bankId: bankId,
    billMonth: formatMonthCell_(cell("billMonth")),
    billPaid: cell("billPaid") === "是",
    reconciled: cell("reconciled") === "已對帳",
    packageNo: String(cell("packageNo") || ""),
    productsText: String(cell("products") || ""),
    productsSubtotalJpy: toNum_(cell("productsSubtotalJpy")),
    shippingJpy: toNum_(cell("shippingJpy")),
    consumptionTaxJpy: toNum_(cell("consumptionTaxJpy")),
    amazonPointsJpy: toNum_(cell("amazonPointsJpy")),
    couponJpy: toNum_(cell("couponJpy")),
    amountJpy: toNum_(cell("amountJpy")),
    amountTwd: toNum_(twdCell),
    payDate: payDate,
    note: String(cell("note") || ""),
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
  return toNum_(n);
}

function toNum_(v) {
  if (v === "" || v === null || v === undefined) return 0;
  // 日期若被放進金額欄，Number(date) 會變成毫秒（上兆的數字），一律視為 0
  if (v instanceof Date) return 0;
  if (typeof v === "boolean") return 0;

  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  if (!isFinite(n)) return 0;
  return Math.round(n) || 0;
}

/** @param {*} v */
function formatDateCell_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(v || "");
}

/** 帳單月份一律回傳 yyyy-MM；試算表可能把 2026-07 自動判定成日期 */
function formatMonthCell_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM");
  }
  const s = String(v || "").trim();
  const matched = s.match(/^(\d{4})-(\d{2})/);
  return matched ? matched[1] + "-" + matched[2] : s;
}

/** @returns {Object[]} */
function getAllSettlements() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTLEMENT_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, SETTLEMENT_HEADERS.length).getValues();
  return data
    .filter(function (row) {
      return row[0] && row[2];
    })
    .map(function (row) {
      return {
        bankId: String(row[0]),
        billMonth: formatMonthCell_(row[2]),
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

  const target = formatMonthCell_(billMonth);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, SETTLEMENT_HEADERS.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === bankId && formatMonthCell_(data[i][2]) === target) {
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

  const target = formatMonthCell_(billMonth);
  const data = sheet.getLastRow() >= 2 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues() : [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === bankId && formatMonthCell_(data[i][2]) === target) {
      sheet.getRange(i + 2, 4, 1, 2).setValues([[paid ? "是" : "否", paidDate || ""]]);
      return;
    }
  }
  sheet.appendRow([bankId, bank.name, target, paid ? "是" : "否", paidDate || ""]);
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
