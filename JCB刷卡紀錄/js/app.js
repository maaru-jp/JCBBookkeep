const STORAGE_KEY = "jcb-card-records-v1";
const SETTLEMENTS_KEY = "jcb-bill-settlements-v1";
const CURRENT_BANK_KEY = "jcb-card-current-bank-v1";

/** @typedef {{ id: string, name: string, subtitle: string, closingDay: number | null }} BankConfig */

/**
 * 銀行設定：要新增銀行請在此陣列加入一筆。
 * closingDay：每月結帳日（1–31）；刷卡日 ≤ 結帳日歸當月帳單，> 結帳日歸次月帳單。
 *           設為 null 則依刷卡日曆法月份（不套用結帳日區間）。
 */
const BANKS = [
  { id: "fubon", name: "富邦銀行", subtitle: "富邦 JCB 刷日幣 · 帳單對台幣", closingDay: 22 },
  { id: "esun", name: "玉山銀行", subtitle: "玉山 JCB 刷日幣 · 帳單對台幣", closingDay: 15 },
];

/** 舊版銀行代碼對照（自動遷移既有資料） */
const LEGACY_BANK_IDS = { jcb: "fubon", cathay: "esun" };

const BANK_BY_ID = Object.fromEntries(BANKS.map((b) => [b.id, b]));
const DEFAULT_BANK_ID = BANKS[0].id;

/** @param {string | undefined} bankId */
function migrateBankId(bankId) {
  if (!bankId) return DEFAULT_BANK_ID;
  const migrated = LEGACY_BANK_IDS[bankId] ?? bankId;
  return BANK_BY_ID[migrated] ? migrated : DEFAULT_BANK_ID;
}

/** @typedef {{ name: string, quantity: number, amountJpy: number }} ProductItem */
/** @typedef {{ id: string, bankId: string, packageNo: string, products: ProductItem[], productsSubtotalJpy: number, amazonPointsJpy: number, couponJpy: number, amountJpy: number, amountTwd: number, payDate: string, billMonth: string, note: string, reconciled: boolean, createdAt: string }} Record */
/** @typedef {{ paid: boolean, paidDate: string }} BillSettlement */

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 依發卡銀行結帳日推算帳單月份 */
/** @param {string} payDate @param {string} [bankId] */
function inferBillMonth(payDate, bankId = DEFAULT_BANK_ID) {
  if (!payDate) return "";
  if (!usesClosingDayRule(bankId)) return payDate.slice(0, 7);

  const closingDay = getClosingDay(bankId);
  const [y, m, d] = payDate.split("-").map(Number);
  const effective = effectiveClosingDay(y, m, closingDay);
  if (d <= effective) return `${y}-${pad2(m)}`;

  let nextY = y;
  let nextM = m + 1;
  if (nextM > 12) {
    nextM = 1;
    nextY += 1;
  }
  return `${nextY}-${pad2(nextM)}`;
}

/** @param {number} year @param {number} month 1–12 */
function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/** @param {number} year @param {number} month 1–12 @param {number} closingDay */
function effectiveClosingDay(year, month, closingDay) {
  return Math.min(closingDay, lastDayOfMonth(year, month));
}

/** @param {string} bankId */
function getClosingDay(bankId) {
  return BANK_BY_ID[bankId]?.closingDay ?? null;
}

/** @param {string} bankId */
function usesClosingDayRule(bankId) {
  const day = getClosingDay(bankId);
  return typeof day === "number" && day >= 1 && day <= 31;
}

/** @param {string} billMonth @param {string} [bankId] */
function formatBillingCycleRange(billMonth, bankId = currentBankId) {
  if (!billMonth || billMonth === "未分類" || !usesClosingDayRule(bankId)) return "";

  const closingDay = getClosingDay(bankId);
  const [y, m] = billMonth.split("-").map(Number);
  const endDay = effectiveClosingDay(y, m, closingDay);

  let prevY = y;
  let prevM = m - 1;
  if (prevM < 1) {
    prevM = 12;
    prevY -= 1;
  }
  const startDay = effectiveClosingDay(prevY, prevM, closingDay) + 1;

  return `結帳區間 ${prevM}/${startDay}～${m}/${endDay}（${closingDay}日結帳）`;
}

/** @param {string} bankId */
function formatClosingDaySummary(bankId) {
  if (!usesClosingDayRule(bankId)) return "依刷卡日曆法月份";
  return `每月 ${getClosingDay(bankId)} 日結帳`;
}

/** @param {unknown} raw */
function normalizeProducts(raw) {
  const r = /** @type {{ products?: unknown[], productName?: string }} */ (raw);
  let products = [];
  if (Array.isArray(r.products)) {
    products = r.products
      .map((p) => {
        if (typeof p === "string") {
          const name = p.trim();
          return name ? { name, quantity: 1, amountJpy: 0 } : null;
        }
        const item = /** @type {{ name?: string, quantity?: number, unitJpy?: number, amountJpy?: number }} */ (p);
        const name = String(item.name ?? "").trim();
        if (!name) return null;
        const quantity = Math.max(1, Math.round(Number(item.quantity ?? 1)));
        let amountJpy = Math.max(0, Math.round(Number(item.amountJpy ?? 0)));
        const unitJpy = Math.round(Number(item.unitJpy ?? 0));
        if (!amountJpy && unitJpy) amountJpy = unitJpy * quantity;
        return { name, quantity, amountJpy };
      })
      .filter(Boolean);
  } else {
    const legacy = (r.productName ?? "").trim();
    if (legacy) products = [{ name: legacy, quantity: 1, amountJpy: 0 }];
  }

  const recordJpy = Number(/** @type {{ amountJpy?: number }} */ (raw).amountJpy ?? 0);
  const sum = products.reduce((s, p) => s + p.amountJpy, 0);
  if (sum === 0 && recordJpy > 0 && products.length === 1) {
    products[0].amountJpy = recordJpy;
  }
  return products;
}

function sumProductsJpy(products) {
  return products.reduce((s, p) => s + p.amountJpy, 0);
}

/** @param {ProductItem} p */
function formatProductLineDisplay(p) {
  const qty = p.quantity > 1 ? `×${p.quantity} ` : "";
  return `${qty}${formatJpy(p.amountJpy)}`;
}

function calcFinalJpy(subtotal, amazonPointsJpy, couponJpy) {
  const amazon = Math.max(0, Math.round(Number(amazonPointsJpy) || 0));
  const coupon = Math.max(0, Math.round(Number(couponJpy) || 0));
  return Math.max(0, subtotal - amazon - coupon);
}

/** @param {{ subtotal: number, amazonPointsJpy: number, couponJpy: number, total: number }} jpy */
function renderJpySummaryHtml(jpy) {
  const lines = [`<div class="jpy-summary__row"><span>商品小計</span><span>${formatJpy(jpy.subtotal)}</span></div>`];
  if (jpy.amazonPointsJpy > 0) {
    lines.push(
      `<div class="jpy-summary__row jpy-summary__row--minus"><span>− 亞馬遜積分</span><span>${formatJpy(jpy.amazonPointsJpy)}</span></div>`
    );
  }
  if (jpy.couponJpy > 0) {
    lines.push(
      `<div class="jpy-summary__row jpy-summary__row--minus"><span>− 平台優惠券</span><span>${formatJpy(jpy.couponJpy)}</span></div>`
    );
  }
  lines.push(
    `<div class="jpy-summary__row jpy-summary__row--total"><span>日幣合計</span><span>${formatJpy(jpy.total)}</span></div>`
  );
  return lines.join("");
}

/** @param {Record} r */
function renderCardJpyDetail(r) {
  const subtotal = r.productsSubtotalJpy ?? sumProductsJpy(r.products);
  if (r.amazonPointsJpy <= 0 && r.couponJpy <= 0) {
    return `<span class="record-card__jpy-ref">日幣合計 ${formatJpy(r.amountJpy)}</span>`;
  }
  const parts = [`小計 ${formatJpy(subtotal)}`];
  if (r.amazonPointsJpy > 0) parts.push(`積分 −¥ ${r.amazonPointsJpy.toLocaleString("ja-JP")}`);
  if (r.couponJpy > 0) parts.push(`券 −¥ ${r.couponJpy.toLocaleString("ja-JP")}`);
  parts.push(`合計 ${formatJpy(r.amountJpy)}`);
  return `<span class="record-card__jpy-ref record-card__jpy-ref--detail">${parts.join(" · ")}</span>`;
}

/** @param {ProductItem[]} products */
function formatProductsLabel(products) {
  if (!products.length) return "（無商品）";
  if (products.length === 1) {
    const p = products[0];
    const qty = p.quantity > 1 ? `×${p.quantity} ` : "";
    return `${p.name} ${qty}${formatJpy(p.amountJpy)}`;
  }
  return `${products[0].name} 等 ${products.length} 項`;
}

/** @param {ProductItem[]} products */
function formatProductsSearch(products) {
  return products.map((p) => `${p.name} ${p.quantity} ${p.amountJpy}`).join(" ");
}

/** @param {ProductItem[]} products */
function formatProductsExport(products) {
  return products
    .map((p) => {
      const qty = p.quantity > 1 ? `×${p.quantity}` : "";
      return `${p.name}${qty}(¥${p.amountJpy})`;
    })
    .join("、");
}

/** @param {ProductItem[]} products */
function renderProductsHtml(products) {
  if (!products.length) {
    return `<p class="record-card__product record-card__product--empty">（無商品）</p>`;
  }
  if (products.length === 1) {
    const p = products[0];
    const qty =
      p.quantity > 1
        ? `<span class="record-card__product-qty">×${p.quantity}</span> `
        : "";
    return `<h3 class="record-card__product">${escapeHtml(p.name)} ${qty}<span class="record-card__product-jpy">${formatProductLineDisplay(p)}</span></h3>`;
  }
  const items = products
    .map(
      (p) =>
        `<li><span class="record-card__product-name">${escapeHtml(p.name)}</span> <span class="record-card__product-jpy">${formatProductLineDisplay(p)}</span></li>`
    )
    .join("");
  return `<ul class="record-card__products" aria-label="商品清單">${items}</ul>`;
}

/** @param {unknown} raw */
function normalizeRecord(raw) {
  const r = /** @type {Record & { amount?: number, productName?: string }} */ (raw);
  const payDate = r.payDate ?? "";
  const products = normalizeProducts(r);
  const productsSubtotalJpy = sumProductsJpy(products);
  const amazonPointsJpy = Math.max(0, Math.round(Number(r.amazonPointsJpy ?? 0)));
  const couponJpy = Math.max(0, Math.round(Number(r.couponJpy ?? 0)));
  let amountJpy = calcFinalJpy(productsSubtotalJpy, amazonPointsJpy, couponJpy);
  if (amountJpy === 0 && productsSubtotalJpy === 0) {
    amountJpy = Math.max(0, Math.round(Number(r.amountJpy ?? 0)));
  }
  const bankId = migrateBankId(r.bankId);
  return {
    id: r.id,
    bankId,
    packageNo: r.packageNo ?? "",
    products,
    productsSubtotalJpy,
    amazonPointsJpy,
    couponJpy,
    amountJpy,
    amountTwd: Number(r.amountTwd ?? r.amount ?? 0),
    payDate,
    billMonth: r.billMonth || inferBillMonth(payDate, bankId),
    note: r.note ?? "",
    reconciled: Boolean(r.reconciled),
    createdAt: r.createdAt ?? new Date().toISOString(),
  };
}

/** @returns {Record[]} */
function loadRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    let needsSave = false;
    const records = data.map((item) => {
      const before = item.bankId;
      const normalized = normalizeRecord(item);
      if (before && migrateBankId(before) !== before) needsSave = true;
      return normalized;
    });
    if (needsSave) localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    return records;
  } catch {
    return [];
  }
}

/** @param {string} key */
function migrateSettlementKey(key) {
  if (/^\d{4}-\d{2}$/.test(key)) return `${DEFAULT_BANK_ID}:${key}`;
  for (const [legacy, next] of Object.entries(LEGACY_BANK_IDS)) {
    const prefix = `${legacy}:`;
    if (key.startsWith(prefix)) return `${next}:${key.slice(prefix.length)}`;
  }
  return key;
}

/** @returns {Record<string, BillSettlement>} */
function loadSettlements() {
  try {
    const raw = localStorage.getItem(SETTLEMENTS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    const migrated = /** @type {Record<string, BillSettlement>} */ ({});
    let needsSave = false;
    for (const [key, val] of Object.entries(data)) {
      const newKey = migrateSettlementKey(key);
      if (newKey !== key) needsSave = true;
      migrated[newKey] = /** @type {BillSettlement} */ (val);
    }
    if (needsSave) saveSettlements(migrated);
    return migrated;
  } catch {
    return {};
  }
}

    if (needsSave) persistSettlements(migrated);
    return migrated;
  } catch {
    return {};
  }
}

/** @param {Record[]} records */
function persistRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

/** @param {Record<string, BillSettlement>} settlements */
function persistSettlements(settlements) {
  localStorage.setItem(SETTLEMENTS_KEY, JSON.stringify(settlements));
}

/** @param {Record[]} records */
function saveRecords(records) {
  persistRecords(records);
  queueSpreadsheetSync();
}

/** @param {Record<string, BillSettlement>} settlements */
function saveSettlements(settlements) {
  persistSettlements(settlements);
  queueSpreadsheetSync();
}

const CSV_HEADERS = [
  "發卡銀行",
  "帳單月份",
  "帳單已繳卡費",
  "明細對帳",
  "包裹單號",
  "商品名稱",
  "商品日幣小計(¥)",
  "亞馬遜積分抵扣(¥)",
  "平台優惠券抵扣(¥)",
  "日幣合計(¥)",
  "台幣金額(NT$)",
  "匯率(台/日)",
  "刷卡日期",
  "備註",
];

const SPREADSHEET_DB = "jcb-spreadsheet-sync-v1";
const SPREADSHEET_STORE = "handles";
const SPREADSHEET_HANDLE_KEY = "csv-file";

/** @type {FileSystemFileHandle | null} */
let spreadsheetHandle = null;
let spreadsheetSyncTimer = null;
let spreadsheetLastSync = "";
let spreadsheetLastError = "";

/** @param {Record} r */
function recordToCsvRow(r) {
  const s = getSettlement(r.billMonth, r.bankId);
  return [
    getBankName(r.bankId),
    r.billMonth,
    s.paid ? "是" : "否",
    r.reconciled ? "已對帳" : "待對帳",
    r.packageNo,
    formatProductsExport(r.products),
    r.productsSubtotalJpy,
    r.amazonPointsJpy || "",
    r.couponJpy || "",
    r.amountJpy,
    r.amountTwd || "",
    impliedRate(r.amountJpy, r.amountTwd) ?? "",
    r.payDate,
    r.note || "",
  ];
}

/** @param {Record[]} list */
function buildRecordsCsv(list) {
  const sorted = [...list].sort(
    (a, b) => b.payDate.localeCompare(a.payDate) || b.createdAt.localeCompare(a.createdAt)
  );
  const bom = "\uFEFF";
  return (
    bom +
    [CSV_HEADERS, ...sorted.map(recordToCsvRow)]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n")
  );
}

function supportsSpreadsheetSync() {
  return typeof window.showSaveFilePicker === "function";
}

function openSpreadsheetDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SPREADSHEET_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(SPREADSHEET_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @returns {Promise<FileSystemFileHandle | null>} */
async function loadStoredSpreadsheetHandle() {
  try {
    const db = await openSpreadsheetDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SPREADSHEET_STORE, "readonly");
      const req = tx.objectStore(SPREADSHEET_STORE).get(SPREADSHEET_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** @param {FileSystemFileHandle} handle */
async function storeSpreadsheetHandle(handle) {
  const db = await openSpreadsheetDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SPREADSHEET_STORE, "readwrite");
    tx.objectStore(SPREADSHEET_STORE).put(handle, SPREADSHEET_HANDLE_KEY);
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

async function clearStoredSpreadsheetHandle() {
  const db = await openSpreadsheetDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SPREADSHEET_STORE, "readwrite");
    tx.objectStore(SPREADSHEET_STORE).delete(SPREADSHEET_HANDLE_KEY);
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/** @param {FileSystemFileHandle} handle */
async function ensureSpreadsheetPermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}

function formatSyncTime() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function updateSpreadsheetUI() {
  const bar = $("#spreadsheetBar");
  const status = $("#spreadsheetStatus");
  const btnSync = $("#btnSyncSpreadsheet");
  const btnUnlink = $("#btnUnlinkSpreadsheet");
  const btnLink = $("#btnLinkSpreadsheet");
  if (!bar || !status) return;

  bar.classList.remove("spreadsheet-bar--linked", "spreadsheet-bar--warn", "spreadsheet-bar--error");

  if (!supportsSpreadsheetSync()) {
    status.textContent =
      "此瀏覽器無法自動寫入試算表，請改用 Chrome／Edge，或改用手動「匯出 CSV」。";
    bar.classList.add("spreadsheet-bar--warn");
    if (btnLink) btnLink.hidden = true;
    if (btnSync) btnSync.hidden = true;
    if (btnUnlink) btnUnlink.hidden = true;
    return;
  }

  if (btnLink) btnLink.hidden = Boolean(spreadsheetHandle);

  if (spreadsheetLastError) {
    status.innerHTML = `試算表同步失敗：<strong>${escapeHtml(spreadsheetLastError)}</strong>。請按「立即同步」重試，或重新連結試算表。`;
    bar.classList.add("spreadsheet-bar--error");
    if (btnSync) btnSync.hidden = false;
    if (btnUnlink) btnUnlink.hidden = !spreadsheetHandle;
    return;
  }

  if (spreadsheetHandle) {
    const name = escapeHtml(spreadsheetHandle.name);
    const syncNote = spreadsheetLastSync ? ` · 已同步 ${spreadsheetLastSync}` : "";
    status.innerHTML = `已連結試算表 <strong>${name}</strong>${syncNote}。新增、編輯、刪除或標記對帳後會自動更新。`;
    bar.classList.add("spreadsheet-bar--linked");
    if (btnSync) btnSync.hidden = false;
    if (btnUnlink) btnUnlink.hidden = false;
    return;
  }

  status.textContent = "尚未連結試算表。連結後，新增／編輯／刪除會自動寫入 CSV。";
  if (btnSync) btnSync.hidden = true;
  if (btnUnlink) btnUnlink.hidden = true;
}

function queueSpreadsheetSync() {
  if (!spreadsheetHandle) return;
  if (spreadsheetSyncTimer) clearTimeout(spreadsheetSyncTimer);
  spreadsheetSyncTimer = setTimeout(() => {
    spreadsheetSyncTimer = null;
    syncSpreadsheet();
  }, 300);
}

async function syncSpreadsheet() {
  if (!spreadsheetHandle) return;

  try {
    const ok = await ensureSpreadsheetPermission(spreadsheetHandle);
    if (!ok) {
      spreadsheetLastError = "需要檔案寫入權限，請按「立即同步」並允許存取";
      updateSpreadsheetUI();
      return;
    }

    const writable = await spreadsheetHandle.createWritable();
    await writable.write(buildRecordsCsv(records));
    await writable.close();

    spreadsheetLastError = "";
    spreadsheetLastSync = formatSyncTime();
    updateSpreadsheetUI();
  } catch (err) {
    spreadsheetLastError = err instanceof Error ? err.message : "無法寫入檔案";
    updateSpreadsheetUI();
  }
}

async function linkSpreadsheet() {
  if (!supportsSpreadsheetSync()) {
    alert("請使用 Chrome 或 Edge 開啟此頁面，才能自動寫入試算表。");
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: "刷卡紀錄.csv",
      types: [{ description: "CSV 試算表", accept: { "text/csv": [".csv"] } }],
    });

    spreadsheetHandle = handle;
    await storeSpreadsheetHandle(handle);
    spreadsheetLastError = "";
    await syncSpreadsheet();
    updateSpreadsheetUI();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    alert(err instanceof Error ? err.message : "無法連結試算表");
  }
}

async function unlinkSpreadsheet() {
  spreadsheetHandle = null;
  spreadsheetLastSync = "";
  spreadsheetLastError = "";
  await clearStoredSpreadsheetHandle();
  updateSpreadsheetUI();
}

async function initSpreadsheetSync() {
  updateSpreadsheetUI();
  if (!supportsSpreadsheetSync()) return;

  const handle = await loadStoredSpreadsheetHandle();
  if (!handle) return;

  spreadsheetHandle = handle;
  const perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") {
    spreadsheetLastError = "請按「立即同步」重新授權試算表寫入";
  }
  updateSpreadsheetUI();
}

function uid() {
  return crypto.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatJpy(n) {
  return `¥ ${Number(n).toLocaleString("ja-JP")}`;
}

function formatTwd(n) {
  if (!n) return "待填帳單台幣";
  return `NT$ ${Number(n).toLocaleString("zh-TW")}`;
}

function formatDual(jpy, twd) {
  return `${formatJpy(jpy)}／${twd ? formatTwd(twd) : "台幣待填"}`;
}

function formatDisplayDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${y}/${m}/${d}`;
}

function formatBillMonthLabel(billMonth) {
  if (!billMonth) return "未分類";
  const [y, m] = billMonth.split("-");
  return `${y} 年 ${Number(m)} 月帳單`;
}

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function currentBillMonth(bankId = currentBankId) {
  return inferBillMonth(todayISO(), bankId);
}

function impliedRate(jpy, twd) {
  if (!jpy || !twd) return null;
  return (twd / jpy).toFixed(4);
}

function settlementKey(bankId, month) {
  return `${bankId}:${month}`;
}

function loadCurrentBank() {
  try {
    const id = localStorage.getItem(CURRENT_BANK_KEY);
    const migrated = id ? migrateBankId(id) : DEFAULT_BANK_ID;
    if (BANK_BY_ID[migrated]) {
      if (id && migrated !== id) localStorage.setItem(CURRENT_BANK_KEY, migrated);
      return migrated;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_BANK_ID;
}

function getBankName(bankId) {
  return BANK_BY_ID[bankId]?.name ?? bankId;
}

/** @param {string} bankId */
function recordsForBank(bankId) {
  return records.filter((r) => r.bankId === bankId);
}

function twdMatchesBill(recordTwd, billTwd) {
  if (!billTwd || !recordTwd) return false;
  return recordTwd === billTwd;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function updateBankUI() {
  const bank = BANK_BY_ID[currentBankId];
  document.title = `${bank.name} 刷卡紀錄 · 對帳`;
  const headerTitle = $("#headerTitle");
  const headerSubtitle = $("#headerSubtitle");
  const reconcileDesc = $("#reconcileDesc");
  if (headerTitle) headerTitle.textContent = `${bank.name} 刷卡紀錄`;
  if (headerSubtitle) headerSubtitle.textContent = bank.subtitle;
  if (reconcileDesc) {
    reconcileDesc.innerHTML = `${bank.name} 帳單明細只顯示<strong>台幣</strong>。請將帳單上的金額輸入下方，即可找出當初刷日幣的購物紀錄。`;
  }
  const monthlyBillsDesc = $("#monthlyBillsDesc");
  if (monthlyBillsDesc) {
    const cycleNote = usesClosingDayRule(currentBankId)
      ? `（${formatClosingDaySummary(currentBankId)}）`
      : "";
    monthlyBillsDesc.innerHTML = `明細依<strong>帳單月份</strong>歸戶${cycleNote}，可自由新增或移至其他月份；繳清卡費後標記「已繳卡費」。`;
  }
  const nav = $("#bankSwitcher");
  if (nav) {
    nav.querySelectorAll("[data-bank]").forEach((btn) => {
      const bankCfg = BANK_BY_ID[btn.dataset.bank];
      if (!bankCfg) return;
      const cycle = usesClosingDayRule(bankCfg.id) ? ` · ${bankCfg.closingDay}日結帳` : "";
      btn.title = `${bankCfg.name}${cycle}`;
    });
  }
  updateBillMonthFormHints();
  $$("[data-bank]").forEach((btn) => {
    const active = btn.dataset.bank === currentBankId;
    btn.classList.toggle("bank-tab--active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function updateBillMonthFormHints(bankId = bankIdInput?.value || currentBankId) {
  const hint = $("#billMonthHint");
  const btn = $("#btnApplyBillMonth");
  if (usesClosingDayRule(bankId)) {
    const day = getClosingDay(bankId);
    if (hint) {
      hint.textContent = `新增時依 ${day} 日結帳規則推算（${formatClosingDaySummary(bankId)}）；仍可依實際帳單手動調整`;
    }
    if (btn) btn.textContent = `依${day}日結帳推算`;
  } else {
    if (hint) hint.textContent = "可自由選擇；新增時預設為刷卡日所在月份";
    if (btn) btn.textContent = "依刷卡日帶入";
  }
}

function initBankSwitcher() {
  const nav = $("#bankSwitcher");
  if (!nav) return;
  nav.innerHTML = BANKS.map(
    (b) =>
      `<button type="button" class="bank-tab" data-bank="${b.id}" role="tab" aria-selected="false">${escapeHtml(b.name)}</button>`
  ).join("");
  nav.querySelectorAll("[data-bank]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextBank = btn.dataset.bank;
      if (!nextBank || nextBank === currentBankId) return;
      currentBankId = nextBank;
      localStorage.setItem(CURRENT_BANK_KEY, currentBankId);
      expandedMonths = new Set([currentBillMonth()]);
      updateBankUI();
      render();
    });
  });
}

function initBankSelect() {
  const sel = $("#bankId");
  if (!sel) return;
  sel.innerHTML = BANKS.map(
    (b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`
  ).join("");
}

function switchBank(bankId) {
  if (!BANK_BY_ID[bankId] || bankId === currentBankId) return;
  currentBankId = bankId;
  localStorage.setItem(CURRENT_BANK_KEY, currentBankId);
  expandedMonths = new Set([currentBillMonth()]);
  updateBankUI();
  render();
}

const recordsList = $("#recordsList");
const emptyState = $("#emptyState");
const monthlyBillsList = $("#monthlyBillsList");
const monthlyBillsEmpty = $("#monthlyBillsEmpty");
const monthlyBillsSection = $("#monthlyBillsSection");
const toolbarSection = $("#toolbarSection");
const searchInput = $("#searchInput");
const filterFrom = $("#filterFrom");
const filterTo = $("#filterTo");
const billTwdLookup = $("#billTwdLookup");
const matchHint = $("#matchHint");
const statPending = $("#statPending");
const statPendingCount = $("#statPendingCount");
const statMonthJpy = $("#statMonthJpy");
const statMonthTwd = $("#statMonthTwd");
const statAllJpy = $("#statAllJpy");
const statAllTwd = $("#statAllTwd");

const recordModal = $("#recordModal");
const recordForm = $("#recordForm");
const modalTitle = $("#modalTitle");
const recordId = $("#recordId");
const packageNo = $("#packageNo");
const productsList = $("#productsList");
const productsJpyTotal = $("#productsJpyTotal");
const amazonPointsJpyInput = $("#amazonPointsJpy");
const couponJpyInput = $("#couponJpy");
const btnAddProduct = $("#btnAddProduct");
const amountTwd = $("#amountTwd");
const payDate = $("#payDate");
const billMonthInput = $("#billMonth");
const note = $("#note");
const bankIdInput = $("#bankId");

const deleteModal = $("#deleteModal");
const deletePreview = $("#deletePreview");

let records = loadRecords();
let settlements = loadSettlements();
let currentBankId = loadCurrentBank();
let pendingDeleteId = null;
let statusFilter = "all";
let sortMode = "date";
let viewMode = "bills";
let expandedMonths = new Set([currentBillMonth()]);

function getBillTwd() {
  const v = billTwdLookup.value.trim();
  if (!v) return null;
  const n = Math.round(Number(v));
  return Number.isNaN(n) || n < 0 ? null : n;
}

function getFiltered() {
  const q = searchInput.value.trim().toLowerCase();
  const from = filterFrom.value;
  const to = filterTo.value;
  const billTwd = getBillTwd();

  let list = recordsForBank(currentBankId).filter((r) => {
    if (statusFilter === "pending" && r.reconciled) return false;
    if (statusFilter === "done" && !r.reconciled) return false;

    if (billTwd !== null && !twdMatchesBill(r.amountTwd, billTwd)) return false;

    if (q) {
      const hay = `${r.packageNo} ${formatProductsSearch(r.products)} ${r.note} ${r.amountTwd} ${r.amountJpy} ${r.billMonth}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (from && r.payDate < from) return false;
    if (to && r.payDate > to) return false;
    return true;
  });

  return [...list].sort((a, b) => {
    if (sortMode === "twd") {
      const diff = (b.amountTwd || 0) - (a.amountTwd || 0);
      if (diff !== 0) return diff;
    }
    return b.payDate.localeCompare(a.payDate) || b.createdAt.localeCompare(a.createdAt);
  });
}

/** @returns {Map<string, Record[]>} */
function groupByBillMonth(list) {
  const map = new Map();
  for (const r of list) {
    const key = r.billMonth || "未分類";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  for (const items of map.values()) {
    items.sort((a, b) => b.payDate.localeCompare(a.payDate));
  }
  return map;
}

function getSettlement(month, bankId = currentBankId) {
  return settlements[settlementKey(bankId, month)] ?? { paid: false, paidDate: "" };
}

function updateMatchHint(filtered, billTwd) {
  if (billTwd === null) {
    matchHint.textContent = "";
    matchHint.className = "reconcile__result";
    return;
  }

  if (filtered.length === 0) {
    matchHint.textContent = `找不到台幣 NT$ ${billTwd.toLocaleString("zh-TW")} 的紀錄。請確認是否已填入台幣，或改搜尋「待對帳」項目。`;
    matchHint.className = "reconcile__result reconcile__result--warn";
    return;
  }

  if (filtered.length === 1) {
    const r = filtered[0];
    matchHint.textContent = `找到 1 筆：${formatProductsLabel(r.products)}（${formatBillMonthLabel(r.billMonth)}，${formatJpy(r.amountJpy)}）— 請核對後標記已對帳`;
    matchHint.className = "reconcile__result reconcile__result--ok";
    return;
  }

  matchHint.textContent = `找到 ${filtered.length} 筆相同台幣金額，請依帳單月份或商品名稱確認`;
  matchHint.className = "reconcile__result reconcile__result--multi";
}

function updateStats() {
  const billMonth = currentBillMonth(currentBankId);
  const bankRecords = recordsForBank(currentBankId);
  const pending = bankRecords.filter((r) => !r.reconciled);
  const monthRecords = bankRecords.filter((r) => r.billMonth === billMonth);
  const monthJpy = monthRecords.reduce((s, r) => s + r.amountJpy, 0);
  const monthTwd = monthRecords.reduce((s, r) => s + r.amountTwd, 0);
  const allJpy = bankRecords.reduce((s, r) => s + r.amountJpy, 0);
  const allTwd = bankRecords.reduce((s, r) => s + r.amountTwd, 0);

  statPending.textContent = `待對帳 ${pending.length} 筆`;
  statPendingCount.textContent = String(pending.length);
  statMonthJpy.textContent = formatJpy(monthJpy);
  statMonthTwd.textContent = formatTwd(monthTwd);
  statAllJpy.textContent = formatJpy(allJpy);
  statAllTwd.textContent = formatTwd(allTwd);
}

function toggleReconciled(id) {
  const idx = records.findIndex((x) => x.id === id);
  if (idx < 0) return;
  records[idx].reconciled = !records[idx].reconciled;
  saveRecords(records);
  render();
}

function toggleBillPaid(month) {
  const key = settlementKey(currentBankId, month);
  const cur = getSettlement(month);
  if (cur.paid) {
    settlements[key] = { paid: false, paidDate: "" };
  } else {
    const items = recordsForBank(currentBankId).filter((r) => r.billMonth === month);
    const unreconciled = items.filter((r) => !r.reconciled).length;
    if (unreconciled > 0) {
      const ok = confirm(
        `${formatBillMonthLabel(month)} 尚有 ${unreconciled} 筆未對帳，確定仍要標記為已繳卡費？`
      );
      if (!ok) return;
    }
    settlements[key] = { paid: true, paidDate: todayISO() };
  }
  saveSettlements(settlements);
  render();
}

function syncBillMonthFromPayDate(force = false) {
  if (!payDate.value) return;
  const bankId = bankIdInput?.value || currentBankId;
  if (force || !recordId.value) {
    billMonthInput.value = inferBillMonth(payDate.value, bankId);
  }
}

/** @returns {string[]} */
function getBillMonthOptions() {
  const bankId = bankIdInput?.value || currentBankId;
  const set = new Set(recordsForBank(currentBankId).map((r) => r.billMonth).filter(Boolean));
  set.add(currentBillMonth(currentBankId));
  if (payDate.value) set.add(inferBillMonth(payDate.value, bankId));
  return [...set].sort((a, b) => b.localeCompare(a));
}

function buildMonthSelectOptions(currentMonth) {
  const months = getBillMonthOptions();
  if (currentMonth && !months.includes(currentMonth)) months.unshift(currentMonth);
  const opts = months
    .map((m) => `<option value="${m}"${m === currentMonth ? " selected" : ""}>${formatBillMonthLabel(m)}</option>`)
    .join("");
  return `${opts}<option value="__custom__">＋ 其他月份…</option>`;
}

function moveRecordToMonth(id, newMonth) {
  if (!newMonth || newMonth === "__custom__") {
    const custom = prompt("請輸入帳單月份（格式 YYYY-MM，例：2025-05）");
    if (!custom || !/^\d{4}-\d{2}$/.test(custom)) {
      render();
      return;
    }
    newMonth = custom;
  }
  const idx = records.findIndex((x) => x.id === id);
  if (idx < 0) return;
  records[idx].billMonth = newMonth;
  saveRecords(records);
  expandedMonths.add(newMonth);
  render();
}

function openAddToMonth(month) {
  openAdd();
  billMonthInput.value = month;
}

function renderRecordCard(r, billTwd) {
  const card = document.createElement("article");
  const isMatch = billTwd !== null && twdMatchesBill(r.amountTwd, billTwd);
  card.className =
    "record-card" +
    (isMatch ? " record-card--match" : "") +
    (r.reconciled ? " record-card--done" : "");
  card.setAttribute("role", "listitem");
  card.dataset.id = r.id;

  const rate = impliedRate(r.amountJpy, r.amountTwd);
  const rateHtml = rate ? `<span class="record-card__rate">匯率約 ${rate}</span>` : "";
  const statusClass = r.reconciled ? "status-badge--done" : "status-badge--pending";
  const statusText = r.reconciled ? "已對帳" : "待對帳";
  const twdClass = r.amountTwd
    ? "record-card__bill-amount"
    : "record-card__bill-amount record-card__bill-amount--empty";
  const noteHtml = r.note ? `<p class="record-card__note">${escapeHtml(r.note)}</p>` : "";
  const suggested = inferBillMonth(r.payDate, r.bankId);
  const monthHintHtml =
    suggested && suggested !== r.billMonth && usesClosingDayRule(r.bankId)
      ? `<p class="record-card__month-hint">依${getClosingDay(r.bankId)}日結帳建議：${formatBillMonthLabel(suggested)}</p>`
      : "";
  card.innerHTML = `
    <div class="record-card__main">
      <div class="record-card__tags">
        <span class="status-badge ${statusClass}">${statusText}</span>
        <span class="record-card__package">${escapeHtml(r.packageNo)}</span>
      </div>
      ${renderProductsHtml(r.products)}
      <div class="record-card__meta">
        <span class="record-card__date">刷卡 ${formatDisplayDate(r.payDate)}</span>
        ${renderCardJpyDetail(r)}
        ${rateHtml}
      </div>
      <label class="move-month">
        <span class="move-month__label">移至帳單月份</span>
        <select class="move-month__select" data-action="move-month" title="可自由移動至其他月份帳單">
          ${buildMonthSelectOptions(r.billMonth)}
        </select>
      </label>
      ${monthHintHtml}
      ${noteHtml}
    </div>
    <div class="record-card__side">
      <div class="record-card__bill">
        <span class="record-card__bill-label">帳單台幣</span>
        <span class="${twdClass}">${formatTwd(r.amountTwd)}</span>
      </div>
      <div class="record-card__actions">
        <button type="button" class="btn-reconcile ${r.reconciled ? "btn-reconcile--done" : ""}" data-action="reconcile">${r.reconciled ? "✓ 已對帳" : "○ 標記已對帳"}</button>
        <button type="button" class="icon-btn" data-action="edit" title="編輯">✎</button>
        <button type="button" class="icon-btn icon-btn--danger" data-action="delete" title="刪除">🗑</button>
      </div>
    </div>
  `;

  card.querySelector('[data-action="reconcile"]').addEventListener("click", () => toggleReconciled(r.id));
  card.querySelector('[data-action="edit"]').addEventListener("click", () => openEdit(r.id));
  card.querySelector('[data-action="delete"]').addEventListener("click", () => openDelete(r.id));
  const monthSelect = card.querySelector('[data-action="move-month"]');
  monthSelect.addEventListener("change", () => {
    const val = monthSelect.value;
    if (val === r.billMonth) return;
    moveRecordToMonth(r.id, val);
  });
  return card;
}

function renderMonthlyBills(filtered, billTwd) {
  monthlyBillsList.innerHTML = "";
  const groups = groupByBillMonth(filtered);
  const months = [...groups.keys()].sort((a, b) => {
    if (a === "未分類") return 1;
    if (b === "未分類") return -1;
    return b.localeCompare(a);
  });

  monthlyBillsEmpty.hidden = months.length > 0;

  for (const month of months) {
    const items = groups.get(month);
    const settlement = getSettlement(month);
    const totalTwd = items.reduce((s, r) => s + (r.amountTwd || 0), 0);
    const totalJpy = items.reduce((s, r) => s + r.amountJpy, 0);
    const reconciledCount = items.filter((r) => r.reconciled).length;
    const pct = items.length ? Math.round((reconciledCount / items.length) * 100) : 0;

    const details = document.createElement("details");
    details.className = "bill-month" + (settlement.paid ? " bill-month--paid" : "");
    details.open = expandedMonths.has(month) || (!settlement.paid && month === currentBillMonth(currentBankId));

    const paidBadge = settlement.paid
      ? `<span class="bill-month__badge bill-month__badge--paid">已繳卡費</span>`
      : `<span class="bill-month__badge bill-month__badge--unpaid">待繳卡費</span>`;

    const paidDateHtml = settlement.paidDate
      ? `<span class="bill-month__paid-date">繳費日 ${formatDisplayDate(settlement.paidDate)}</span>`
      : "";

    const cycleHtml = formatBillingCycleRange(month, currentBankId);
    const cycleBlock = cycleHtml
      ? `<p class="bill-month__cycle">${cycleHtml}</p>`
      : "";

    details.innerHTML = `
      <summary class="bill-month__summary">
        <div class="bill-month__summary-main">
          <h3 class="bill-month__title">${formatBillMonthLabel(month)}</h3>
          ${cycleBlock}
          <div class="bill-month__badges">${paidBadge}<span class="bill-month__badge bill-month__badge--count">${items.length} 筆</span></div>
        </div>
        <div class="bill-month__summary-side">
          <span class="bill-month__total">${formatTwd(totalTwd)}</span>
          <span class="bill-month__sub">${formatJpy(totalJpy)}</span>
        </div>
      </summary>
      <div class="bill-month__body">
        <div class="bill-month__progress-wrap">
          <div class="bill-month__progress-label">
            <span>明細對帳 ${reconciledCount}/${items.length}</span>
            <span>${pct}%</span>
          </div>
          <div class="bill-month__progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
            <div class="bill-month__progress-bar" style="width:${pct}%"></div>
          </div>
        </div>
        ${paidDateHtml}
        <div class="bill-month__actions">
          <button type="button" class="btn btn--ghost btn--sm" data-add-month="${month}">＋ 新增至此月份</button>
          <button type="button" class="btn btn--sm ${settlement.paid ? "btn--ghost" : "btn--primary"}" data-pay-month="${month}">
            ${settlement.paid ? "改為待繳卡費" : "✓ 標記本月已繳卡費"}
          </button>
        </div>
        <div class="bill-month__items" role="list"></div>
      </div>
    `;

    details.addEventListener("toggle", () => {
      if (details.open) expandedMonths.add(month);
      else expandedMonths.delete(month);
    });

    const itemsEl = details.querySelector(".bill-month__items");
    items.forEach((r) => itemsEl.appendChild(renderRecordCard(r, billTwd)));

    details.querySelector("[data-pay-month]").addEventListener("click", (e) => {
      e.preventDefault();
      toggleBillPaid(month);
    });

    const addBtn = details.querySelector("[data-add-month]");
    if (addBtn) {
      addBtn.addEventListener("click", (e) => {
        e.preventDefault();
        openAddToMonth(month);
      });
    }

    monthlyBillsList.appendChild(details);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function render() {
  const billTwd = getBillTwd();
  const filtered = getFiltered();

  updateMatchHint(filtered, billTwd);
  updateStats();

  const isBillsView = viewMode === "bills";
  monthlyBillsSection.hidden = !isBillsView;
  toolbarSection.hidden = isBillsView;
  recordsList.hidden = isBillsView;

  if (isBillsView) {
    renderMonthlyBills(filtered, billTwd);
    return;
  }

  recordsList.querySelectorAll(".record-card").forEach((el) => el.remove());
  const showEmpty = filtered.length === 0;
  emptyState.hidden = !showEmpty;

  if (showEmpty && billTwd !== null) {
    emptyState.querySelector(".empty__title").textContent = "找不到相符紀錄";
    emptyState.querySelector(".empty__hint").textContent =
      "請確認該筆是否已填入台幣金額，或點「編輯」補上帳單上的 NT$ 金額";
  } else if (showEmpty) {
    emptyState.querySelector(".empty__title").textContent = "尚無紀錄";
    emptyState.querySelector(".empty__hint").textContent =
      "點擊「新增紀錄」記錄日幣購物，收到帳單後用上方快速對帳查找";
  }

  filtered.forEach((r) => recordsList.appendChild(renderRecordCard(r, billTwd)));
}

function setActiveTab(groupSelector, activeBtn) {
  $$(groupSelector).forEach((btn) => {
    const isActive = btn === activeBtn;
    btn.classList.toggle("tab--active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

/** @param {ProductItem[]} [products] */
function renderProductInputs(products) {
  productsList.innerHTML = "";
  const list = products?.length ? products : [{ name: "", quantity: 1, amountJpy: 0 }];

  list.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "product-row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "field__input product-row__name";
    nameInput.value = item.name;
    nameInput.placeholder = "商品名稱";
    nameInput.maxLength = 200;
    nameInput.required = true;

    const qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.className = "field__input product-row__qty";
    qtyInput.value = String(item.quantity || 1);
    qtyInput.min = "1";
    qtyInput.step = "1";
    qtyInput.required = true;
    qtyInput.inputMode = "numeric";
    qtyInput.title = "數量";

    const jpyWrap = document.createElement("div");
    jpyWrap.className = "product-row__jpy-wrap";

    const jpyPrefix = document.createElement("span");
    jpyPrefix.className = "product-row__jpy-prefix";
    jpyPrefix.textContent = "¥";

    const jpyInput = document.createElement("input");
    jpyInput.type = "number";
    jpyInput.className = "field__input product-row__jpy";
    jpyInput.value = item.amountJpy ? String(item.amountJpy) : "";
    jpyInput.placeholder = "金額";
    jpyInput.min = "1";
    jpyInput.step = "1";
    jpyInput.required = true;
    jpyInput.inputMode = "numeric";
    jpyInput.title = "該項日幣金額";

    jpyWrap.appendChild(jpyPrefix);
    jpyWrap.appendChild(jpyInput);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "icon-btn product-row__remove";
    removeBtn.title = "移除此商品";
    removeBtn.setAttribute("aria-label", "移除此商品");
    removeBtn.textContent = "×";
    if (list.length <= 1) removeBtn.disabled = true;

    const onChange = () => updateProductsJpyTotal();

    nameInput.addEventListener("input", onChange);
    qtyInput.addEventListener("input", onChange);
    jpyInput.addEventListener("input", onChange);

    removeBtn.addEventListener("click", () => {
      const current = collectProductsFromForm();
      current.splice(index, 1);
      renderProductInputs(current.length ? current : [{ name: "", quantity: 1, amountJpy: 0 }]);
    });

    row.appendChild(nameInput);
    row.appendChild(qtyInput);
    row.appendChild(jpyWrap);
    row.appendChild(removeBtn);
    productsList.appendChild(row);
  });

  updateProductsJpyTotal();
}

function getDeductionsFromForm() {
  return {
    amazonPointsJpy: Math.max(0, Math.round(Number(amazonPointsJpyInput.value) || 0)),
    couponJpy: Math.max(0, Math.round(Number(couponJpyInput.value) || 0)),
  };
}

function updateProductsJpyTotal() {
  const subtotal = sumProductsJpy(collectProductsFromForm());
  const { amazonPointsJpy, couponJpy } = getDeductionsFromForm();
  const total = calcFinalJpy(subtotal, amazonPointsJpy, couponJpy);
  productsJpyTotal.innerHTML = renderJpySummaryHtml({
    subtotal,
    amazonPointsJpy,
    couponJpy,
    total,
  });
}

/** @returns {ProductItem[]} */
function collectProductsFromForm() {
  return [...productsList.querySelectorAll(".product-row")]
    .map((row) => {
      const name = row.querySelector(".product-row__name").value.trim();
      const quantity = Math.max(1, Math.round(Number(row.querySelector(".product-row__qty").value)));
      const amountJpy = Math.round(Number(row.querySelector(".product-row__jpy").value));
      return {
        name,
        quantity: Number.isNaN(quantity) ? 1 : quantity,
        amountJpy: Number.isNaN(amountJpy) ? 0 : amountJpy,
      };
    })
    .filter((p) => p.name);
}

function openAdd() {
  modalTitle.textContent = "新增刷卡紀錄";
  recordId.value = "";
  recordForm.reset();
  if (bankIdInput) bankIdInput.value = currentBankId;
  updateBillMonthFormHints(currentBankId);
  payDate.value = todayISO();
  syncBillMonthFromPayDate();
  renderProductInputs([{ name: "", quantity: 1, amountJpy: 0 }]);
  amazonPointsJpyInput.value = "0";
  couponJpyInput.value = "0";
  updateProductsJpyTotal();
  recordModal.showModal();
  packageNo.focus();
}

function openEdit(id) {
  const r = records.find((x) => x.id === id);
  if (!r) return;

  modalTitle.textContent = "編輯刷卡紀錄";
  recordId.value = r.id;
  if (bankIdInput) bankIdInput.value = r.bankId;
  updateBillMonthFormHints(r.bankId);
  packageNo.value = r.packageNo;
  renderProductInputs(r.products.length ? r.products : [{ name: "", quantity: 1, amountJpy: 0 }]);
  amazonPointsJpyInput.value = String(r.amazonPointsJpy || 0);
  couponJpyInput.value = String(r.couponJpy || 0);
  updateProductsJpyTotal();
  amountTwd.value = r.amountTwd ? String(r.amountTwd) : "";
  payDate.value = r.payDate;
  billMonthInput.value = r.billMonth || inferBillMonth(r.payDate, r.bankId);
  note.value = r.note || "";
  recordModal.showModal();
  if (!r.amountTwd) amountTwd.focus();
}

function openDelete(id) {
  const r = records.find((x) => x.id === id);
  if (!r) return;

  pendingDeleteId = id;
  deletePreview.textContent = `確定刪除「${formatProductsLabel(r.products)}」（${r.packageNo}，${formatDual(r.amountJpy, r.amountTwd)}）？`;
  deleteModal.showModal();
}

function handleSave(e) {
  e.preventDefault();

  const twdRaw = amountTwd.value.trim();
  const products = collectProductsFromForm();
  const productsSubtotalJpy = sumProductsJpy(products);
  const { amazonPointsJpy, couponJpy } = getDeductionsFromForm();
  const amountJpy = calcFinalJpy(productsSubtotalJpy, amazonPointsJpy, couponJpy);
  const data = {
    bankId: bankIdInput?.value && BANK_BY_ID[bankIdInput.value] ? bankIdInput.value : currentBankId,
    packageNo: packageNo.value.trim(),
    products,
    productsSubtotalJpy,
    amazonPointsJpy,
    couponJpy,
    amountJpy,
    amountTwd: twdRaw === "" ? 0 : Math.round(Number(twdRaw)),
    payDate: payDate.value,
    billMonth: billMonthInput.value,
    note: note.value.trim(),
  };

  const invalidProducts = products.some((p) => p.amountJpy < 1 || p.quantity < 1);
  const invalid =
    !data.bankId ||
    !data.packageNo ||
    !data.products.length ||
    !data.payDate ||
    !data.billMonth ||
    invalidProducts ||
    data.amountJpy < 0 ||
    data.amountTwd < 0 ||
    Number.isNaN(data.amountTwd) ||
    data.amazonPointsJpy + data.couponJpy > data.productsSubtotalJpy;

  if (invalid) {
    if (data.amazonPointsJpy + data.couponJpy > data.productsSubtotalJpy) {
      alert("亞馬遜積分與優惠券合計不能超過商品日幣小計。");
    }
    return;
  }

  const id = recordId.value;
  if (id) {
    const idx = records.findIndex((x) => x.id === id);
    if (idx >= 0) records[idx] = { ...records[idx], ...data };
  } else {
    records.push({
      id: uid(),
      ...data,
      reconciled: false,
      createdAt: new Date().toISOString(),
    });
  }

  saveRecords(records);
  if (data.bankId !== currentBankId) {
    switchBank(data.bankId);
  }
  expandedMonths.add(data.billMonth);
  recordModal.close();
  render();
}

function confirmDelete() {
  if (pendingDeleteId) {
    records = records.filter((x) => x.id !== pendingDeleteId);
    saveRecords(records);
    pendingDeleteId = null;
  }
  deleteModal.close();
  render();
}

function exportCSV() {
  const filtered = getFiltered();
  const blob = new Blob([buildRecordsCsv(filtered)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${getBankName(currentBankId)}刷卡紀錄_${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearAllFilters() {
  searchInput.value = "";
  filterFrom.value = "";
  filterTo.value = "";
  billTwdLookup.value = "";
  render();
}

$("#btnAdd").addEventListener("click", openAdd);
btnAddProduct.addEventListener("click", () => {
  renderProductInputs([...collectProductsFromForm(), { name: "", quantity: 1, amountJpy: 0 }]);
  const inputs = productsList.querySelectorAll(".product-row__name");
  inputs[inputs.length - 1]?.focus();
});
$("#btnExport").addEventListener("click", exportCSV);
$("#btnLinkSpreadsheet").addEventListener("click", () => linkSpreadsheet());
$("#btnSyncSpreadsheet").addEventListener("click", () => syncSpreadsheet());
$("#btnUnlinkSpreadsheet").addEventListener("click", () => unlinkSpreadsheet());
$("#btnCloseModal").addEventListener("click", () => recordModal.close());
$("#btnCancel").addEventListener("click", () => recordModal.close());
recordForm.addEventListener("submit", handleSave);
payDate.addEventListener("change", () => syncBillMonthFromPayDate(false));
if (bankIdInput) {
  bankIdInput.addEventListener("change", () => {
    updateBillMonthFormHints();
    if (!recordId.value) syncBillMonthFromPayDate(true);
  });
}
amazonPointsJpyInput.addEventListener("input", updateProductsJpyTotal);
couponJpyInput.addEventListener("input", updateProductsJpyTotal);

const btnApplyBillMonth = $("#btnApplyBillMonth");
if (btnApplyBillMonth) {
  btnApplyBillMonth.addEventListener("click", () => syncBillMonthFromPayDate(true));
}

$("#btnCancelDelete").addEventListener("click", () => {
  pendingDeleteId = null;
  deleteModal.close();
});
$("#btnConfirmDelete").addEventListener("click", confirmDelete);

$("#btnClearFilter").addEventListener("click", clearAllFilters);
$("#btnClearBillLookup").addEventListener("click", () => {
  billTwdLookup.value = "";
  billTwdLookup.focus();
  render();
});

$$('[data-status]').forEach((btn) => {
  btn.addEventListener("click", () => {
    statusFilter = btn.dataset.status;
    setActiveTab('[data-status]', btn);
    render();
  });
});

$$('[data-sort]').forEach((btn) => {
  btn.addEventListener("click", () => {
    sortMode = btn.dataset.sort;
    setActiveTab('[data-sort]', btn);
    render();
  });
});

$$('[data-view]').forEach((btn) => {
  btn.addEventListener("click", () => {
    viewMode = btn.dataset.view;
    setActiveTab('[data-view]', btn);
    render();
  });
});

searchInput.addEventListener("input", render);
filterFrom.addEventListener("change", render);
filterTo.addEventListener("change", render);
billTwdLookup.addEventListener("input", render);

initBankSwitcher();
initBankSelect();
updateBankUI();
initSpreadsheetSync();
render();
