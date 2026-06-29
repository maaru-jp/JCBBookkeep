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

## Web App API（選用）

若要讓前端網頁與 Google 試算表同步：

1. Apps Script → **部署** → **新增部署**
2. 類型：**網路應用程式**
3. 執行身分：**我**
4. 誰可以存取：**任何人**（或依需求限制）
5. 複製部署 URL

### API 範例

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
