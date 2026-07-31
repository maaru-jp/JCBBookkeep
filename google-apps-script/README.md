# Google Apps Script 試算表後端

一個 Google 試算表、**每家銀行一個分頁**，與本專案前端欄位對齊。

## 試算表結構

```
您的試算表.xlsx（Google 試算表）
├── [分頁] 富邦銀行
├── [分頁] 玉山銀行
└── [分頁] _帳單繳費   ← 各月是否已繳卡費
```

### 富邦銀行 / 玉山銀行 分頁欄位

| 欄 | 欄位名 |
|----|--------|
| A | 紀錄ID（系統用，請勿刪除） |
| B | 帳單月份 |
| C | 帳單已繳卡費 |
| D | 明細對帳 |
| E | 包裹單號 |
| F | 商品名稱 |
| G～N | 日幣／台幣／日期／備註… |

## 安裝步驟

1. 開啟 [Google 試算表](https://sheets.google.com)，建立新試算表
2. **延伸功能** → **Apps Script**
3. 刪除預設的 `Code.gs` 內容，貼上 [`Code.gs`](Code.gs) 全部程式
4. 儲存專案
5. 下拉選單選 **initializeSpreadsheet** → **執行**（首次需授權 Google 帳號）
6. 回到試算表重新整理，選單 **刷卡紀錄** → **插入範例資料**（可選）

## 試算表選單功能

| 功能 | 說明 |
|------|------|
| 初始化試算表 | 建立富邦、玉山、_帳單繳費 分頁與標題列 |
| 插入範例資料 | 寫入示範紀錄 |
| 匯出全部 JSON | 除錯用，輸出至執行紀錄 |

## 與前端 index.html 連線

1. 完成上方「安裝步驟」並部署 **網路應用程式**
2. 部署時「誰可以存取」選 **任何人**
3. 複製部署 URL（結尾須為 **`/exec`**，不是 `/dev`）
4. **Code.gs 更新後**：部署 → 管理部署 → 編輯 → **新增版本** → 再部署
5. 雙擊 **`start-server.bat`**，用 **http://localhost:8080** 開啟前端（勿直接雙擊 html）
6. **Google 試算表** 區塊貼上 URL → **連結 Google**
7. 之後新增／編輯／刪除會自動上傳；也可按 **從雲端載入** 拉回試算表資料

> 若從 `file://` 開啟網頁可能因 CORS 無法連線，建議部署到 GitHub Pages 或用本機伺服器開啟。

### Web App API

**讀取全部紀錄**

```
GET {部署URL}?action=all
```

**讀取單一銀行**

```
GET {部署URL}?action=bank&bankId=fubon
```

**整批同步（POST JSON）**

```json
{
  "action": "syncAll",
  "records": [
    { "bankId": "fubon", "records": [ /* ... */ ] },
    { "bankId": "esun", "records": [ /* ... */ ] }
  ],
  "settlements": [
    { "bankId": "fubon", "billMonth": "2025-05", "paid": true, "paidDate": "2025-06-10" }
  ]
}
```

## 銀行 ID 對照

| bankId | 分頁名稱 | 結帳日 |
|--------|----------|--------|
| fubon | 富邦銀行 | 22 日 |
| esun | 玉山銀行 | 15 日 |

新增銀行時，請同步修改 `Code.gs` 與 `js/app.js` 的 `BANKS` 設定。
