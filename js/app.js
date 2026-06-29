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
  queueGoogleSync();
}

/** @param {Record<string, BillSettlement>} settlements */
function saveSettlements(settlements) {
  persistSettlements(settlements);
  queueGoogleSync();
}

/** @param {Record[]} list */
function sortRecords(list) {
  return [...list].sort(
    (a, b) => b.payDate.localeCompare(a.payDate) || b.createdAt.localeCompare(a.createdAt)
  );
}

/** @param {BankConfig} bank */
function sheetNameForBank(bank) {
  return bank.name.replace(/[\\/*?:\[\]]/g, "").slice(0, 31) || bank.id;
}

function formatSyncTime() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function isLocalFilePage() {
  return location.protocol === "file:";
}

function isSecurePage() {
  return location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

function showOriginWarning() {
  const banner = $("#originWarning");
  if (!banner) return;
  if (isLocalFilePage()) {
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

// ─── Google 試算表同步（Apps Script Web App）────────────────

const GAS_URL_KEY = "jcb-gas-webapp-url-v1";

let gasWebAppUrl = "";
let googleSyncTimer = null;
let googleLastSync = "";
let googleLastError = "";
let googleSyncing = false;

function loadGasUrl() {
  try {
    return localStorage.getItem(GAS_URL_KEY) || "";
  } catch {
    return "";
  }
}

function saveGasUrl(url) {
  gasWebAppUrl = url.trim();
  localStorage.setItem(GAS_URL_KEY, gasWebAppUrl);
}

function isGoogleConnected() {
  return Boolean(gasWebAppUrl);
}

/** @param {string} text */
function parseProductsText(text) {
  const raw = (text || "").trim();
  if (!raw) return [{ name: "（未命名）", quantity: 1, amountJpy: 0 }];
  return raw.split("、").map((part) => {
    const m = part.trim().match(/^(.+?)(×(\d+))?\(¥(\d+)\)$/);
    if (!m) return { name: part.trim(), quantity: 1, amountJpy: 0 };
    return {
      name: m[1].trim(),
      quantity: Math.max(1, parseInt(m[3] || "1", 10)),
      amountJpy: parseInt(m[4], 10) || 0,
    };
  });
}

/** @param {Record} r */
function recordToGasPayload(r) {
  return {
    id: r.id,
    bankId: r.bankId,
    billMonth: r.billMonth,
    reconciled: r.reconciled,
    packageNo: r.packageNo,
    products: r.products,
    productsSubtotalJpy: r.productsSubtotalJpy,
    amazonPointsJpy: r.amazonPointsJpy,
    couponJpy: r.couponJpy,
    amountJpy: r.amountJpy,
    amountTwd: r.amountTwd,
    payDate: r.payDate,
    note: r.note,
    createdAt: r.createdAt,
  };
}

function buildGoogleSyncPayload() {
  return {
    action: "syncAll",
    records: BANKS.map((bank) => ({
      bankId: bank.id,
      records: records.filter((r) => r.bankId === bank.id).map(recordToGasPayload),
    })),
    settlements: Object.entries(settlements)
      .map(([key, val]) => {
        const sep = key.indexOf(":");
        if (sep < 0) return null;
        return {
          bankId: key.slice(0, sep),
          billMonth: key.slice(sep + 1),
          paid: val.paid,
          paidDate: val.paidDate || "",
        };
      })
      .filter(Boolean),
  };
}

/** @param {Object} payload */
async function gasJsonpGet(params) {
  const baseUrl = gasWebAppUrl.trim();
  if (!baseUrl) throw new Error("尚未設定 Google 試算表 URL");

  return new Promise((resolve, reject) => {
    const callback = "_gasCb_" + Date.now();
    const url = new URL(baseUrl);
    url.searchParams.set("action", params.action || "all");
    if (params.bankId) url.searchParams.set("bankId", params.bankId);
    url.searchParams.set("callback", callback);

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Google 連線逾時，請確認 URL 與部署權限"));
    }, 45000);

    function cleanup() {
      clearTimeout(timeout);
      delete window[callback];
      if (script.parentNode) script.remove();
    }

    window[callback] = (data) => {
      cleanup();
      if (!data || !data.ok) {
        reject(new Error((data && data.error) || "Google 讀取失敗"));
        return;
      }
      resolve(data);
    };

    const script = document.createElement("script");
    script.src = url.toString();
    script.onerror = () => {
      cleanup();
      reject(new Error("無法連線 Google（URL 錯誤或未部署為「任何人」可存取）"));
    };
    document.head.appendChild(script);
  });
}

/** @param {Object} payload @param {boolean} [writeOnly] */
async function gasPost(payload, writeOnly = false) {
  const url = gasWebAppUrl.trim();
  if (!url) throw new Error("尚未設定 Google 試算表 URL");

  const isReadAction = payload.action === "all" || payload.action === "bank";

  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Google 回應格式錯誤，請確認部署 URL 是否為「網路應用程式」");
    }
    if (!data.ok) throw new Error(data.error || "Google 同步失敗");
    return data;
  } catch (err) {
    if (isReadAction && !writeOnly) {
      return gasJsonpGet(payload);
    }

    if (isLocalFilePage() || !isSecurePage()) {
      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      return { ok: true, viaNoCors: true };
    }

    throw err instanceof Error ? err : new Error("Google 同步失敗");
  }
}

/** @param {{ records?: Object[], settlements?: Object[] }} data */
function applyGoogleData(data) {
  if (Array.isArray(data.records)) {
    records = data.records.map((r) =>
      normalizeRecord({
        ...r,
        products: r.products?.length ? r.products : parseProductsText(r.productsText),
      })
    );
    persistRecords(records);
  }

  if (Array.isArray(data.settlements) && data.settlements.length) {
    const next = { ...settlements };
    for (const s of data.settlements) {
      if (!s.bankId || !s.billMonth) continue;
      next[settlementKey(s.bankId, s.billMonth)] = {
        paid: Boolean(s.paid),
        paidDate: s.paidDate || "",
      };
    }
    settlements = next;
    persistSettlements(settlements);
  }
}

function updateGoogleSyncUI() {
  const bar = $("#googleBar");
  const status = $("#googleStatus");
  const btnConnect = $("#btnConnectGoogle");
  const btnPull = $("#btnPullGoogle");
  const btnSync = $("#btnSyncGoogle");
  const btnDisconnect = $("#btnDisconnectGoogle");
  const urlInput = $("#gasUrlInput");
  if (!bar || !status) return;

  bar.classList.remove("spreadsheet-bar--linked", "spreadsheet-bar--warn", "spreadsheet-bar--error");

  if (googleSyncing) {
    status.textContent = "正在與 Google 試算表同步…";
    return;
  }

  if (googleLastError) {
    status.innerHTML = `Google 同步失敗：<strong>${escapeHtml(googleLastError)}</strong>。${isLocalFilePage() ? "file:// 開啟時建議改用 start-server.bat → http://localhost:8080。" : "請檢查 URL 與部署權限後重試。"}`;
    bar.classList.add("spreadsheet-bar--error");
    if (urlInput) urlInput.hidden = false;
    if (btnConnect) btnConnect.hidden = isGoogleConnected();
    if (btnPull) btnPull.hidden = !isGoogleConnected();
    if (btnSync) btnSync.hidden = !isGoogleConnected();
    if (btnDisconnect) btnDisconnect.hidden = !isGoogleConnected();
    return;
  }

  if (isGoogleConnected()) {
    const syncNote = googleLastSync ? ` · 已同步 ${googleLastSync}` : "";
    const sheets = BANKS.map((b) => sheetNameForBank(b)).join("、");
    status.innerHTML = `已連結 Google 試算表${syncNote}。分頁：<strong>${escapeHtml(sheets)}</strong>；新增或修改紀錄後自動寫入。`;
    bar.classList.add("spreadsheet-bar--linked");
    if (urlInput) {
      urlInput.value = gasWebAppUrl;
      urlInput.hidden = true;
    }
    if (btnConnect) btnConnect.hidden = true;
    if (btnPull) btnPull.hidden = false;
    if (btnSync) btnSync.hidden = false;
    if (btnDisconnect) btnDisconnect.hidden = false;
    return;
  }

  status.textContent = isLocalFilePage()
    ? "file:// 模式下可用 JSONP 連線 Google。建議執行 start-server.bat 後用 http://localhost:8080 開啟，自動寫入更穩定。"
    : "請先連結 Google 試算表；新增或修改紀錄後會自動寫入（每家銀行一個分頁）。";
  if (urlInput) urlInput.hidden = false;
  if (btnConnect) btnConnect.hidden = false;
  if (btnPull) btnPull.hidden = true;
  if (btnSync) btnSync.hidden = true;
  if (btnDisconnect) btnDisconnect.hidden = true;
}

function queueGoogleSync() {
  if (!isGoogleConnected()) return;
  if (googleSyncTimer) clearTimeout(googleSyncTimer);
  googleSyncTimer = setTimeout(() => {
    googleSyncTimer = null;
    syncGoogle();
  }, 800);
}

async function syncGoogle() {
  if (!isGoogleConnected() || googleSyncing) return;

  googleSyncing = true;
  googleLastError = "";
  updateGoogleSyncUI();

  try {
    await gasPost(buildGoogleSyncPayload(), true);
    googleLastSync = formatSyncTime();
  } catch (err) {
    googleLastError = err instanceof Error ? err.message : "Google 同步失敗";
    updateGoogleSyncUI();
  } finally {
    googleSyncing = false;
    updateGoogleSyncUI();
  }
}

async function pullFromGoogle() {
  if (!isGoogleConnected()) return;

  googleSyncing = true;
  googleLastError = "";
  updateGoogleSyncUI();

  try {
    const data = await gasPost({ action: "all" });
    applyGoogleData(data);
    googleLastSync = formatSyncTime();
    for (const bank of BANKS) {
      getBankState(bank.id).expandedMonths = new Set([currentBillMonth(bank.id)]);
    }
    render();
    updateGoogleSyncUI();
  } catch (err) {
    googleLastError = err instanceof Error ? err.message : "無法從 Google 載入";
    updateGoogleSyncUI();
  } finally {
    googleSyncing = false;
    updateGoogleSyncUI();
  }
}

async function connectGoogle() {
  const urlInput = $("#gasUrlInput");
  const url = (urlInput?.value || "").trim();
  if (!url.includes("script.google.com") || !url.includes("/exec")) {
    alert("請貼上 Apps Script「網路應用程式」的部署 URL\n（需包含 script.google.com 且結尾為 /exec，不是 /dev）");
    return;
  }

  saveGasUrl(url);
  googleSyncing = true;
  googleLastError = "";
  updateGoogleSyncUI();

  try {
    const remote = await gasPost({ action: "all" });
    const hasRemote = (remote.records || []).length > 0;
    const hasLocal = records.length > 0;

    if (hasRemote && hasLocal) {
      const useRemote = confirm(
        "Google 試算表與本機都有資料。\n\n按「確定」→ 以 Google 覆蓋本機\n按「取消」→ 以本機覆蓋 Google"
      );
      if (useRemote) {
        applyGoogleData(remote);
        render();
      } else {
        await gasPost(buildGoogleSyncPayload(), true);
      }
    } else if (hasRemote) {
      applyGoogleData(remote);
      render();
    } else {
      await gasPost(buildGoogleSyncPayload(), true);
    }

    googleLastSync = formatSyncTime();
    googleLastError = "";
    updateGoogleSyncUI();
    alert("已成功連結 Google 試算表！" + (isLocalFilePage() ? "\n\n建議之後改用 http://localhost:8080 開啟，同步更穩定。" : ""));
  } catch (err) {
    googleLastError = err instanceof Error ? err.message : "連結失敗";
    updateGoogleSyncUI();
    alert("連結失敗：\n" + googleLastError + (isLocalFilePage() ? "\n\n請執行 start-server.bat，用 http://localhost:8080 開啟後再試。" : ""));
  } finally {
    googleSyncing = false;
    updateGoogleSyncUI();
  }
}

function disconnectGoogle() {
  gasWebAppUrl = "";
  googleLastSync = "";
  googleLastError = "";
  localStorage.removeItem(GAS_URL_KEY);
  const urlInput = $("#gasUrlInput");
  if (urlInput) urlInput.value = "";
  updateGoogleSyncUI();
}

function initGoogleSync() {
  gasWebAppUrl = loadGasUrl();
  const urlInput = $("#gasUrlInput");
  if (urlInput && gasWebAppUrl) urlInput.value = gasWebAppUrl;
  updateGoogleSyncUI();
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

/** @typedef {{ viewMode: string, statusFilter: string, sortMode: string, expandedMonths: Set<string> }} BankPanelState */

/** @type {Record<string, BankPanelState>} */
const bankPanelState = {};

function createBankPanelState(bankId) {
  return {
    viewMode: "bills",
    statusFilter: "all",
    sortMode: "date",
    expandedMonths: new Set([currentBillMonth(bankId)]),
  };
}

/** @param {string} bankId */
function getBankState(bankId) {
  if (!bankPanelState[bankId]) bankPanelState[bankId] = createBankPanelState(bankId);
  return bankPanelState[bankId];
}

/** @param {BankConfig} bank */
function bankPanelTemplate(bank) {
  const cycle = usesClosingDayRule(bank.id)
    ? `<span class="bank-panel__cycle">${formatClosingDaySummary(bank.id)}</span>`
    : "";
  const cycleDesc = usesClosingDayRule(bank.id)
    ? `（${formatClosingDaySummary(bank.id)}）`
    : "";

  return `
    <section class="bank-panel" id="bank-panel-${bank.id}" data-bank="${bank.id}" aria-labelledby="bank-panel-title-${bank.id}">
      <header class="bank-panel__head">
        <div class="bank-panel__head-main">
          <h2 class="bank-panel__title" id="bank-panel-title-${bank.id}">${escapeHtml(bank.name)}</h2>
          ${cycle}
          <p class="bank-panel__desc">${escapeHtml(bank.subtitle)} · 明細依<strong>帳單月份</strong>歸戶${cycleDesc}</p>
        </div>
        <div class="bank-panel__head-actions">
          <span class="bank-panel__pending" data-pending-badge>待對帳 0 筆</span>
          <button type="button" class="btn btn--ghost btn--sm" data-action="add-record" data-bank="${bank.id}">＋ 新增</button>
        </div>
      </header>

      <div class="stats stats--dual bank-panel__stats" aria-label="${escapeHtml(bank.name)}統計">
        <article class="stat-card stat-card--pending">
          <span class="stat-card__label">待對帳</span>
          <strong class="stat-card__value" data-stat-pending>0</strong>
        </article>
        <article class="stat-card stat-card--jpy">
          <span class="stat-card__label">本期帳單日幣</span>
          <strong class="stat-card__value" data-stat-month-jpy>¥ 0</strong>
        </article>
        <article class="stat-card stat-card--accent">
          <span class="stat-card__label">本期帳單台幣</span>
          <strong class="stat-card__value" data-stat-month-twd>NT$ 0</strong>
        </article>
        <article class="stat-card stat-card--all">
          <span class="stat-card__label">全部累計</span>
          <strong class="stat-card__value stat-card__value--sm" data-stat-all-jpy>¥ 0</strong>
          <strong class="stat-card__value" data-stat-all-twd>NT$ 0</strong>
        </article>
      </div>

      <section class="reconcile bank-panel__reconcile" aria-label="${escapeHtml(bank.name)}快速對帳">
        <div class="reconcile__top">
          <div>
            <h3 class="reconcile__title">快速對帳</h3>
            <p class="reconcile__desc">帳單明細只顯示<strong>台幣</strong>。輸入帳單金額即可找出刷日幣的購物紀錄。</p>
          </div>
        </div>
        <div class="reconcile__lookup">
          <label class="bill-lookup">
            <span class="bill-lookup__label">帳單台幣金額</span>
            <span class="bill-lookup__input-wrap">
              <span class="bill-lookup__prefix">NT$</span>
              <input type="number" class="bill-lookup__input" data-bill-lookup inputmode="numeric" min="0" step="1" placeholder="輸入明細上的台幣金額" />
            </span>
          </label>
          <button type="button" class="btn btn--ghost btn--sm" data-action="clear-bill-lookup">清除金額</button>
        </div>
        <p class="reconcile__result" data-match-hint aria-live="polite"></p>
        <div class="reconcile__controls">
          <div class="tab-group" role="tablist" aria-label="對帳狀態">
            <button type="button" class="tab tab--active" data-status="all" data-bank="${bank.id}" role="tab" aria-selected="true">全部</button>
            <button type="button" class="tab" data-status="pending" data-bank="${bank.id}" role="tab">待對帳</button>
            <button type="button" class="tab" data-status="done" data-bank="${bank.id}" role="tab">已對帳</button>
          </div>
          <div class="tab-group" role="tablist" aria-label="排序">
            <button type="button" class="tab tab--active" data-sort="date" data-bank="${bank.id}" role="tab">依日期</button>
            <button type="button" class="tab" data-sort="twd" data-bank="${bank.id}" role="tab">依台幣金額</button>
          </div>
        </div>
      </section>

      <section class="monthly-bills bank-panel__bills" aria-label="${escapeHtml(bank.name)}每月帳單">
        <div class="monthly-bills__head">
          <h3 class="monthly-bills__title">每月帳單</h3>
          <div class="view-mode tab-group" role="tablist" aria-label="檢視模式">
            <button type="button" class="tab tab--active" data-view="bills" data-bank="${bank.id}" role="tab" aria-selected="true">月份帳單</button>
            <button type="button" class="tab" data-view="list" data-bank="${bank.id}" role="tab">明細列表</button>
          </div>
        </div>
        <div class="monthly-bills__list" data-bills-list></div>
        <p class="monthly-bills__empty" data-bills-empty hidden>尚無帳單資料，請先新增刷卡紀錄。</p>
      </section>

      <section class="toolbar bank-panel__toolbar" data-toolbar hidden>
        <div class="search">
          <svg class="search__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="search" class="search__input" data-search placeholder="搜尋包裹單號、商品名稱、台幣金額…" autocomplete="off" />
        </div>
        <div class="filters">
          <label class="filter-label">
            <span>起日</span>
            <input type="date" class="filter-date" data-filter-from />
          </label>
          <label class="filter-label">
            <span>迄日</span>
            <input type="date" class="filter-date" data-filter-to />
          </label>
          <button type="button" class="btn btn--ghost btn--sm" data-action="clear-filters">清除篩選</button>
        </div>
      </section>

      <main class="records bank-panel__records" data-records-list role="list" aria-label="${escapeHtml(bank.name)}刷卡紀錄" hidden>
        <div class="empty" data-empty-state>
          <div class="empty__icon" aria-hidden="true">🌸</div>
          <p class="empty__title">尚無紀錄</p>
          <p class="empty__hint">點擊「新增」開始記錄此銀行的刷卡歷程</p>
        </div>
      </main>
    </section>
  `;
}

function initBankPanels() {
  const overview = $("#bankOverview");
  const panels = $("#bankPanels");
  if (!overview || !panels) return;

  overview.innerHTML = BANKS.map(
    (b) => `
      <a class="bank-overview-card" href="#bank-panel-${b.id}" data-bank="${b.id}">
        <span class="bank-overview-card__name">${escapeHtml(b.name)}</span>
        <span class="bank-overview-card__meta" data-overview-meta>0 筆 · 待對帳 0</span>
        <span class="bank-overview-card__amounts" data-overview-amounts>本期 NT$ 0</span>
      </a>
    `
  ).join("");

  panels.innerHTML = BANKS.map((b) => bankPanelTemplate(b)).join("");

  overview.querySelectorAll("[data-bank]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      scrollToBank(link.dataset.bank);
    });
  });

  panels.querySelectorAll('[data-action="add-record"]').forEach((btn) => {
    btn.addEventListener("click", () => openAdd(btn.dataset.bank));
  });

  panels.addEventListener("click", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const bankId = target.closest("[data-bank]")?.dataset.bank;
    if (!bankId) return;

    const statusBtn = target.closest("[data-status][data-bank]");
    if (statusBtn) {
      getBankState(bankId).statusFilter = statusBtn.dataset.status || "all";
      setActiveTabInPanel(bankId, "[data-status]", statusBtn);
      render();
      return;
    }

    const sortBtn = target.closest("[data-sort][data-bank]");
    if (sortBtn) {
      getBankState(bankId).sortMode = sortBtn.dataset.sort || "date";
      setActiveTabInPanel(bankId, "[data-sort]", sortBtn);
      render();
      return;
    }

    const viewBtn = target.closest("[data-view][data-bank]");
    if (viewBtn) {
      getBankState(bankId).viewMode = viewBtn.dataset.view || "bills";
      setActiveTabInPanel(bankId, "[data-view]", viewBtn);
      render();
      return;
    }

    if (target.closest('[data-action="clear-bill-lookup"]')) {
      const panel = getBankPanel(bankId);
      const input = panel?.querySelector("[data-bill-lookup]");
      if (input instanceof HTMLInputElement) {
        input.value = "";
        input.focus();
      }
      render();
      return;
    }

    if (target.closest('[data-action="clear-filters"]')) {
      clearPanelFilters(bankId);
      render();
    }
  });

  panels.addEventListener("input", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (
      target.matches("[data-bill-lookup]") ||
      target.matches("[data-search]") ||
      target.matches("[data-filter-from]") ||
      target.matches("[data-filter-to]")
    ) {
      render();
    }
  });

  panels.addEventListener("change", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches("[data-filter-from]") || target.matches("[data-filter-to]")) {
      render();
    }
  });
}

/** @param {string} bankId */
function getBankPanel(bankId) {
  return $(`#bank-panel-${bankId}`);
}

/** @param {string} bankId */
function scrollToBank(bankId) {
  if (!BANK_BY_ID[bankId]) return;
  currentBankId = bankId;
  localStorage.setItem(CURRENT_BANK_KEY, currentBankId);
  getBankPanel(bankId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** @param {string} bankId @param {string} groupSelector @param {Element} activeBtn */
function setActiveTabInPanel(bankId, groupSelector, activeBtn) {
  const panel = getBankPanel(bankId);
  if (!panel) return;
  panel.querySelectorAll(groupSelector).forEach((btn) => {
    const isActive = btn === activeBtn;
    btn.classList.toggle("tab--active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

/** @param {string} bankId */
function clearPanelFilters(bankId) {
  const panel = getBankPanel(bankId);
  if (!panel) return;
  const search = panel.querySelector("[data-search]");
  const from = panel.querySelector("[data-filter-from]");
  const to = panel.querySelector("[data-filter-to]");
  const bill = panel.querySelector("[data-bill-lookup]");
  if (search instanceof HTMLInputElement) search.value = "";
  if (from instanceof HTMLInputElement) from.value = "";
  if (to instanceof HTMLInputElement) to.value = "";
  if (bill instanceof HTMLInputElement) bill.value = "";
}

function initBankSelect() {
  const sel = $("#bankId");
  if (!sel) return;
  sel.innerHTML = BANKS.map(
    (b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`
  ).join("");
}

function scrollToBankAfterSave(bankId) {
  currentBankId = bankId;
  localStorage.setItem(CURRENT_BANK_KEY, currentBankId);
  requestAnimationFrame(() => scrollToBank(bankId));
}

const bankPanels = $("#bankPanels");
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

/** @param {string} bankId */
function getBillTwdForBank(bankId) {
  const panel = getBankPanel(bankId);
  const input = panel?.querySelector("[data-bill-lookup]");
  if (!(input instanceof HTMLInputElement)) return null;
  const v = input.value.trim();
  if (!v) return null;
  const n = Math.round(Number(v));
  return Number.isNaN(n) || n < 0 ? null : n;
}

/** @param {string} bankId */
function getFilteredForBank(bankId) {
  const panel = getBankPanel(bankId);
  const state = getBankState(bankId);
  const searchEl = panel?.querySelector("[data-search]");
  const fromEl = panel?.querySelector("[data-filter-from]");
  const toEl = panel?.querySelector("[data-filter-to]");
  const q = searchEl instanceof HTMLInputElement ? searchEl.value.trim().toLowerCase() : "";
  const from = fromEl instanceof HTMLInputElement ? fromEl.value : "";
  const to = toEl instanceof HTMLInputElement ? toEl.value : "";
  const billTwd = getBillTwdForBank(bankId);

  let list = recordsForBank(bankId).filter((r) => {
    if (state.statusFilter === "pending" && r.reconciled) return false;
    if (state.statusFilter === "done" && !r.reconciled) return false;
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
    if (state.sortMode === "twd") {
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

/** @param {string} bankId @param {Record[]} filtered @param {number | null} billTwd */
function updateMatchHintForBank(bankId, filtered, billTwd) {
  const panel = getBankPanel(bankId);
  const matchHint = panel?.querySelector("[data-match-hint]");
  if (!matchHint) return;

  if (billTwd === null) {
    matchHint.textContent = "";
    matchHint.className = "reconcile__result";
    return;
  }

  if (filtered.length === 0) {
    matchHint.textContent = `找不到台幣 NT$ ${billTwd.toLocaleString("zh-TW")} 的紀錄。請確認是否已填入台幣，或改篩選「待對帳」項目。`;
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

/** @param {string} bankId */
function updateStatsForBank(bankId) {
  const panel = getBankPanel(bankId);
  if (!panel) return;

  const billMonth = currentBillMonth(bankId);
  const bankRecords = recordsForBank(bankId);
  const pending = bankRecords.filter((r) => !r.reconciled);
  const monthRecords = bankRecords.filter((r) => r.billMonth === billMonth);
  const monthJpy = monthRecords.reduce((s, r) => s + r.amountJpy, 0);
  const monthTwd = monthRecords.reduce((s, r) => s + r.amountTwd, 0);
  const allJpy = bankRecords.reduce((s, r) => s + r.amountJpy, 0);
  const allTwd = bankRecords.reduce((s, r) => s + r.amountTwd, 0);

  const pendingBadge = panel.querySelector("[data-pending-badge]");
  if (pendingBadge) pendingBadge.textContent = `待對帳 ${pending.length} 筆`;

  const statPending = panel.querySelector("[data-stat-pending]");
  const statMonthJpy = panel.querySelector("[data-stat-month-jpy]");
  const statMonthTwd = panel.querySelector("[data-stat-month-twd]");
  const statAllJpy = panel.querySelector("[data-stat-all-jpy]");
  const statAllTwd = panel.querySelector("[data-stat-all-twd]");

  if (statPending) statPending.textContent = String(pending.length);
  if (statMonthJpy) statMonthJpy.textContent = formatJpy(monthJpy);
  if (statMonthTwd) statMonthTwd.textContent = formatTwd(monthTwd);
  if (statAllJpy) statAllJpy.textContent = formatJpy(allJpy);
  if (statAllTwd) statAllTwd.textContent = formatTwd(allTwd);

  const overviewCard = $(`.bank-overview-card[data-bank="${bankId}"]`);
  if (overviewCard) {
    const meta = overviewCard.querySelector("[data-overview-meta]");
    const amounts = overviewCard.querySelector("[data-overview-amounts]");
    if (meta) meta.textContent = `${bankRecords.length} 筆 · 待對帳 ${pending.length}`;
    if (amounts) amounts.textContent = `本期 ${formatTwd(monthTwd)} · ${formatJpy(monthJpy)}`;
  }
}

function toggleReconciled(id) {
  const idx = records.findIndex((x) => x.id === id);
  if (idx < 0) return;
  records[idx].reconciled = !records[idx].reconciled;
  saveRecords(records);
  render();
}

/** @param {string} month @param {string} bankId */
function toggleBillPaid(month, bankId) {
  const key = settlementKey(bankId, month);
  const cur = getSettlement(month, bankId);
  if (cur.paid) {
    settlements[key] = { paid: false, paidDate: "" };
  } else {
    const items = recordsForBank(bankId).filter((r) => r.billMonth === month);
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

/** @param {string} bankId @returns {string[]} */
function getBillMonthOptions(bankId) {
  const set = new Set(recordsForBank(bankId).map((r) => r.billMonth).filter(Boolean));
  set.add(currentBillMonth(bankId));
  const formBankId = bankIdInput?.value || bankId;
  if (payDate.value && formBankId === bankId) set.add(inferBillMonth(payDate.value, bankId));
  return [...set].sort((a, b) => b.localeCompare(a));
}

function buildMonthSelectOptions(currentMonth, bankId) {
  const months = getBillMonthOptions(bankId);
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
  getBankState(records[idx].bankId).expandedMonths.add(newMonth);
  render();
}

function openAddToMonth(month, bankId) {
  openAdd(bankId);
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
          ${buildMonthSelectOptions(r.billMonth, r.bankId)}
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

/** @param {string} bankId @param {Record[]} filtered @param {number | null} billTwd */
function renderMonthlyBillsForBank(bankId, filtered, billTwd) {
  const panel = getBankPanel(bankId);
  if (!panel) return;
  const monthlyBillsList = panel.querySelector("[data-bills-list]");
  const monthlyBillsEmpty = panel.querySelector("[data-bills-empty]");
  if (!monthlyBillsList || !monthlyBillsEmpty) return;

  const state = getBankState(bankId);
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
    const settlement = getSettlement(month, bankId);
    const totalTwd = items.reduce((s, r) => s + (r.amountTwd || 0), 0);
    const totalJpy = items.reduce((s, r) => s + r.amountJpy, 0);
    const reconciledCount = items.filter((r) => r.reconciled).length;
    const pct = items.length ? Math.round((reconciledCount / items.length) * 100) : 0;

    const details = document.createElement("details");
    details.className = "bill-month" + (settlement.paid ? " bill-month--paid" : "");
    details.open =
      state.expandedMonths.has(month) || (!settlement.paid && month === currentBillMonth(bankId));

    const paidBadge = settlement.paid
      ? `<span class="bill-month__badge bill-month__badge--paid">已繳卡費</span>`
      : `<span class="bill-month__badge bill-month__badge--unpaid">待繳卡費</span>`;

    const paidDateHtml = settlement.paidDate
      ? `<span class="bill-month__paid-date">繳費日 ${formatDisplayDate(settlement.paidDate)}</span>`
      : "";

    const cycleHtml = formatBillingCycleRange(month, bankId);
    const cycleBlock = cycleHtml ? `<p class="bill-month__cycle">${cycleHtml}</p>` : "";

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
      if (details.open) state.expandedMonths.add(month);
      else state.expandedMonths.delete(month);
    });

    const itemsEl = details.querySelector(".bill-month__items");
    items.forEach((r) => itemsEl.appendChild(renderRecordCard(r, billTwd)));

    details.querySelector("[data-pay-month]").addEventListener("click", (e) => {
      e.preventDefault();
      toggleBillPaid(month, bankId);
    });

    const addBtn = details.querySelector("[data-add-month]");
    if (addBtn) {
      addBtn.addEventListener("click", (e) => {
        e.preventDefault();
        openAddToMonth(month, bankId);
      });
    }

    monthlyBillsList.appendChild(details);
  }
}

/** @param {string} bankId @param {Record[]} filtered @param {number | null} billTwd */
function renderRecordsListForBank(bankId, filtered, billTwd) {
  const panel = getBankPanel(bankId);
  if (!panel) return;
  const recordsList = panel.querySelector("[data-records-list]");
  const emptyState = panel.querySelector("[data-empty-state]");
  if (!recordsList || !emptyState) return;

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
      "點擊「新增」記錄日幣購物，收到帳單後用上方快速對帳查找";
  }

  filtered.forEach((r) => recordsList.appendChild(renderRecordCard(r, billTwd)));
}

/** @param {string} bankId */
function renderBankPanel(bankId) {
  const panel = getBankPanel(bankId);
  if (!panel) return;

  const state = getBankState(bankId);
  const billTwd = getBillTwdForBank(bankId);
  const filtered = getFilteredForBank(bankId);

  updateMatchHintForBank(bankId, filtered, billTwd);
  updateStatsForBank(bankId);

  const isBillsView = state.viewMode === "bills";
  const billsSection = panel.querySelector(".bank-panel__bills");
  const toolbar = panel.querySelector("[data-toolbar]");
  const recordsList = panel.querySelector("[data-records-list]");

  if (billsSection) billsSection.hidden = !isBillsView;
  if (toolbar) toolbar.hidden = isBillsView;
  if (recordsList) recordsList.hidden = isBillsView;

  if (isBillsView) {
    renderMonthlyBillsForBank(bankId, filtered, billTwd);
  } else {
    renderRecordsListForBank(bankId, filtered, billTwd);
  }
}

function render() {
  for (const bank of BANKS) {
    renderBankPanel(bank.id);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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

/** @param {string} [bankId] */
function openAdd(bankId = currentBankId) {
  modalTitle.textContent = "新增刷卡紀錄";
  recordId.value = "";
  recordForm.reset();
  if (bankIdInput) bankIdInput.value = bankId;
  currentBankId = bankId;
  updateBillMonthFormHints(bankId);
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
  getBankState(data.bankId).expandedMonths.add(data.billMonth);
  recordModal.close();
  render();
  scrollToBankAfterSave(data.bankId);
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

function clearAllFilters() {
  for (const bank of BANKS) clearPanelFilters(bank.id);
  render();
}

function bindClick(selector, handler) {
  const el = $(selector);
  if (el) el.addEventListener("click", handler);
}

bindClick("#btnAdd", () => openAdd(currentBankId));
btnAddProduct.addEventListener("click", () => {
  renderProductInputs([...collectProductsFromForm(), { name: "", quantity: 1, amountJpy: 0 }]);
  const inputs = productsList.querySelectorAll(".product-row__name");
  inputs[inputs.length - 1]?.focus();
});
bindClick("#btnConnectGoogle", () => connectGoogle());
bindClick("#btnPullGoogle", () => pullFromGoogle());
bindClick("#btnSyncGoogle", () => syncGoogle());
bindClick("#btnDisconnectGoogle", () => disconnectGoogle());
bindClick("#btnCloseModal", () => recordModal.close());
bindClick("#btnCancel", () => recordModal.close());
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

initBankPanels();
initBankSelect();
showOriginWarning();
initGoogleSync();
render();

if (BANK_BY_ID[currentBankId]) {
  requestAnimationFrame(() => scrollToBank(currentBankId));
}
