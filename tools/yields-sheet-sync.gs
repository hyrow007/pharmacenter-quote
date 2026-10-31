/**
 * Yields <-> Google Sheet daily sync.
 *
 * Lives in the "Packaging Yields v2.1" spreadsheet (Extensions -> Apps Script)
 * and runs on Google's servers every day around 5:15 pm Eastern -- no laptop,
 * no browser. Source of truth for this file: pharmacenter-quote/tools/.
 *
 *   1. sends the Data tab's rows from FIRST_ROW on to the Yields app, which
 *      inserts the new ones (rows already there are never overwritten) and
 *      fills real Fishbowl grosses;
 *   2. writes the gross per finished unit back into column J, with
 *      K = H*J, and N = L*M / O = K/N on new rows; formats J, K, O as money.
 *
 * Auth: the script sends the installing user's Google token; the app accepts
 * it only for a PharmaCenter admin. No secret is stored here.
 *
 * Setup (once): paste this file, save, run installDailyTrigger, click Allow.
 * Manual run any time: the "Yields" menu in the sheet -> "Sync with app now".
 */

const APP_URL = 'https://quote.pharmacenter.app/api/yields/sheet-sync';
const SHEET_NAME = 'Data';
const FIRST_ROW = 3412;
// Rows whose column J holds hand-typed formulas -- never overwritten.
const KEEP_J = [3415, 3416, 3417, 3418];

function syncYields() {
  // Touching the user's email makes Apps Script request the userinfo.email
  // scope, which the app needs to know who is calling.
  const who = Session.getActiveUser().getEmail();

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const last = sh.getLastRow();
  const n = last - FIRST_ROW + 1;
  if (n <= 0) return;

  const vals = sh.getRange(FIRST_ROW, 1, n, 15).getDisplayValues();
  const res = UrlFetchApp.fetch(APP_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ from_row: FIRST_ROW, rows: vals }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Yields app refused the sync (' + res.getResponseCode() + ', ' + who + '): ' +
      res.getContentText().slice(0, 300));
  }
  const out = JSON.parse(res.getContentText());

  // Column J (values) and K (formula), written in one block; rows with no
  // data and the KEEP_J rows keep whatever they already have.
  const jkRange = sh.getRange(FIRST_ROW, 10, n, 2);
  const jkFormulas = jkRange.getFormulas();
  const jkValues = jkRange.getValues();
  const jk = [];
  for (let i = 0; i < n; i++) {
    const r = FIRST_ROW + i;
    const hasData = vals[i][0] !== '' || vals[i][2] !== '';
    const keepJ = jkFormulas[i][0] || jkValues[i][0];
    const keepK = jkFormulas[i][1] || jkValues[i][1];
    if (!hasData || KEEP_J.indexOf(r) >= 0) {
      jk.push([keepJ, keepK]);
      continue;
    }
    const g = out.gross[String(r)];
    jk.push([g == null ? '' : Math.round(g * 10000) / 10000, '=IF(J' + r + '="","",H' + r + '*J' + r + ')']);
  }
  jkRange.setValues(jk);

  // N and O on rows that do not have them yet.
  for (let i = 0; i < n; i++) {
    const r = FIRST_ROW + i;
    const hasData = vals[i][0] !== '' || vals[i][2] !== '';
    if (!hasData) continue;
    if (vals[i][13] === '') sh.getRange(r, 14).setFormula('=L' + r + '*M' + r);
    if (vals[i][14] === '') sh.getRange(r, 15).setFormula('=IF(OR(K' + r + '="",N' + r + '=0),"",K' + r + '/N' + r + ')');
  }

  sh.getRange(FIRST_ROW, 10, n, 1).setNumberFormat('$#,##0.00');
  sh.getRange(FIRST_ROW, 11, n, 1).setNumberFormat('$#,##0');
  sh.getRange(FIRST_ROW, 15, n, 1).setNumberFormat('$#,##0');

  PropertiesService.getDocumentProperties().setProperty(
    'lastYieldsSync',
    new Date().toISOString() + ' imported=' + out.imported + ' filled=' + out.filled
  );
  console.log('Yields sync: imported ' + out.imported + ', filled ' + out.filled +
    (out.skipped && out.skipped.length ? ', skipped rows ' + out.skipped.join(',') : ''));
}

/** Run once: replaces any earlier schedule with one daily run near 5:15 pm Eastern. */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'syncYields'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncYields')
    .timeBased()
    .everyDays(1)
    .atHour(17)
    .nearMinute(15)
    .inTimezone('America/New_York')
    .create();
  syncYields();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Yields')
    .addItem('Sync with app now', 'syncYields')
    .addToUi();
}
