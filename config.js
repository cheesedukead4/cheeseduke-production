/*
 * 生產部看板｜設定（這個檔案任何人都看得到，不要放密碼）
 *
 * PD_AUTH.clientId：Google Cloud「OAuth 用戶端 ID」（網頁應用程式類型），是公開資訊。
 *   建立方式見「使用說明.md」第 1 步。雲端後端（雲端後端/Code.gs）的 GOOGLE_CLIENT_ID_ 也要填同一個 ID。
 * PD_CLOUD.url：本 App 的 Apps Script 網頁應用程式網址（結尾 /exec），見「使用說明.md」第 2 步。
 */
window.PD_AUTH = {
  // 目前沿用「生產出貨庫存效期管理」的用戶端 ID（同一個 cheesedukead4.github.io 網域可以共用）
  clientId: '916301580469-tbugbbui1i6jc7ogn1gncc1hg13d27uq.apps.googleusercontent.com'
};

window.PD_CLOUD = {
  url: ''
};
