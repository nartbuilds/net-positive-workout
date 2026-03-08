/**
 * Net Positive Workout — Google Apps Script Backend
 *
 * Deploy as a Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * Sheet tabs required:
 *   - completions  : date | person | exercise | completed
 *   - participants : name | pin | colorIndex
 *   - tokens       : token | person | device | timestamp
 */

// ============================================================
// CONFIG — Update these after Firebase setup
// ============================================================
const FCM_SERVER_KEY = 'YOUR_FCM_SERVER_KEY_HERE'; // Legacy HTTP key from Firebase Console

// ============================================================
// SHEET HELPERS
// ============================================================

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    // Add headers
    const headers = {
      completions:  ['date', 'person', 'exercise', 'completed'],
      participants: ['name', 'pin', 'colorIndex'],
      tokens:       ['token', 'person', 'device', 'timestamp'],
    };
    if (headers[name]) {
      sheet.getRange(1, 1, 1, headers[name].length).setValues([headers[name]]);
      sheet.getRange(1, 1, 1, headers[name].length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function corsResponse(data) {
  // Apps Script doesn't support setting headers in doGet/doPost directly,
  // but JSONP can be used as alternative — here we use standard JSON
  return jsonResponse(data);
}

// ============================================================
// GET HANDLER — handles ALL actions (reads + writes)
// Using GET-only avoids CORS preflight (OPTIONS) which Apps Script
// cannot respond to. All data is passed as URL query parameters.
// ============================================================

function doGet(e) {
  const action = e.parameter.action;
  try {
    switch (action) {
      case 'getParticipants':   return handleGetParticipants();
      case 'getCompletions':    return handleGetCompletions();
      case 'getTokens':         return handleGetTokens();
      case 'setCompletion':     return handleSetCompletion(e.parameter);
      case 'addParticipant':    return handleAddParticipant(e.parameter);
      case 'removeParticipant': return handleRemoveParticipant(e.parameter);
      case 'registerToken':     return handleRegisterToken(e.parameter);
      default:
        return jsonResponse({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

function handleGetParticipants() {
  const sheet = getSheet('participants');
  const rows = sheetToObjects(sheet);
  // Return without PINs in the list — PIN is only checked server-side on POST
  // Actually we need PINs on client for offline PIN comparison.
  // This is a trust-based system (no sensitive data), so PINs are included.
  const participants = rows.map(r => ({
    name: String(r.name || '').trim(),
    pin: String(r.pin || '').trim(),
    colorIndex: parseInt(r.colorIndex) || 0,
  })).filter(p => p.name);
  return jsonResponse({ data: participants });
}

function handleGetCompletions() {
  const sheet = getSheet('completions');
  const rows = sheetToObjects(sheet);
  const completions = rows.map(r => ({
    date: String(r.date || '').trim(),
    person: String(r.person || '').trim(),
    exercise: String(r.exercise || '').trim(),
    completed: r.completed === true || r.completed === 'TRUE' || r.completed === 1,
  })).filter(c => c.date && c.person && c.exercise);
  return jsonResponse({ data: completions });
}

function handleGetTokens() {
  const sheet = getSheet('tokens');
  const rows = sheetToObjects(sheet);
  const tokens = rows.map(r => ({
    token: String(r.token || '').trim(),
    person: String(r.person || '').trim(),
    device: String(r.device || '').trim(),
    timestamp: String(r.timestamp || '').trim(),
  })).filter(t => t.token);
  return jsonResponse({ data: tokens });
}

// ============================================================
// POST HANDLER
// ============================================================

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' });
  }

  const action = body.action;
  try {
    switch (action) {
      case 'setCompletion':    return handleSetCompletion(body);
      case 'addParticipant':   return handleAddParticipant(body);
      case 'removeParticipant': return handleRemoveParticipant(body);
      case 'registerToken':    return handleRegisterToken(body);
      default:
        return jsonResponse({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

// ============================================================
// SET COMPLETION
// ============================================================

function handleSetCompletion(body) {
  const { date, person, exercise, completed } = body;

  if (!date || !person || !exercise) {
    return jsonResponse({ error: 'Missing required fields: date, person, exercise' });
  }

  const sheet = getSheet('completions');
  const data = sheet.getDataRange().getValues();
  const headers = data[0]; // ['date','person','exercise','completed']

  // Find existing row
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (
      String(data[i][0]).trim() === String(date).trim() &&
      String(data[i][1]).trim() === String(person).trim() &&
      String(data[i][2]).trim() === String(exercise).trim()
    ) {
      rowIndex = i + 1; // 1-indexed
      break;
    }
  }

  const completedBool = completed === true || completed === 'true' || completed === '1';

  if (rowIndex > 0) {
    // Update existing
    sheet.getRange(rowIndex, 4).setValue(completedBool);
  } else {
    // Append new row
    sheet.appendRow([
      String(date).trim(),
      String(person).trim(),
      String(exercise).trim(),
      completedBool,
    ]);
  }

  // Check if person just completed all exercises for today
  let notifyAll = false;
  let notifMessage = '';

  if (completedBool && String(date).trim() === getTodayStr()) {
    const exercises = ['squats', 'pushups', 'plank'];
    const allData = sheet.getDataRange().getValues();
    const todayRows = allData.slice(1).filter(r =>
      String(r[0]).trim() === String(date).trim() &&
      String(r[1]).trim() === String(person).trim()
    );
    const completedExercises = todayRows
      .filter(r => r[3] === true || r[3] === 'TRUE')
      .map(r => String(r[2]).trim());

    const allDone = exercises.every(ex => completedExercises.includes(ex));

    if (allDone) {
      notifyAll = true;
      notifMessage = `💪 ${person} just completed today's workout!`;
      sendPushToAll(notifMessage, person);
    }
  }

  return jsonResponse({ success: true, notifyAll, message: notifMessage });
}

// ============================================================
// ADD PARTICIPANT
// ============================================================

function handleAddParticipant(body) {
  const { name, pin, colorIndex } = body;

  if (!name || !pin) {
    return jsonResponse({ error: 'Name and PIN are required' });
  }
  if (String(pin).length !== 4 || !/^\d{4}$/.test(String(pin))) {
    return jsonResponse({ error: 'PIN must be exactly 4 digits' });
  }

  const sheet = getSheet('participants');
  const rows = sheetToObjects(sheet);

  // Check for duplicate name
  if (rows.some(r => String(r.name).trim().toLowerCase() === String(name).trim().toLowerCase())) {
    return jsonResponse({ error: 'A participant with this name already exists' });
  }

  const newColorIndex = typeof colorIndex === 'number' ? colorIndex : rows.length;
  sheet.appendRow([
    String(name).trim(),
    String(pin).trim(),
    newColorIndex,
  ]);

  return jsonResponse({ success: true, name, colorIndex: newColorIndex });
}

// ============================================================
// REMOVE PARTICIPANT
// ============================================================

function handleRemoveParticipant(body) {
  const { name } = body;
  if (!name) return jsonResponse({ error: 'Name is required' });

  const sheet = getSheet('participants');
  const data = sheet.getDataRange().getValues();

  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === String(name).trim().toLowerCase()) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex < 0) {
    return jsonResponse({ error: 'Participant not found' });
  }

  sheet.deleteRow(rowIndex);

  // Note: completions history is intentionally retained in the completions sheet
  // so that fine history for other participants' reference is preserved.
  return jsonResponse({ success: true });
}

// ============================================================
// REGISTER FCM TOKEN
// ============================================================

function handleRegisterToken(body) {
  const { token, person, device } = body;
  if (!token) return jsonResponse({ error: 'Token is required' });

  const sheet = getSheet('tokens');
  const data = sheet.getDataRange().getValues();

  // Update if token exists, else append
  let found = false;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(token).trim()) {
      sheet.getRange(i + 1, 2).setValue(String(person || '').trim());
      sheet.getRange(i + 1, 3).setValue(String(device || '').trim());
      sheet.getRange(i + 1, 4).setValue(new Date().toISOString());
      found = true;
      break;
    }
  }

  if (!found) {
    sheet.appendRow([
      String(token).trim(),
      String(person || '').trim(),
      String(device || '').trim(),
      new Date().toISOString(),
    ]);
  }

  return jsonResponse({ success: true });
}

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================

/**
 * Send a push notification to all registered devices EXCEPT
 * the completing person's own devices.
 *
 * Uses FCM Legacy HTTP API (v1 migration guide in README).
 * To upgrade to FCM HTTP v1, update this function per the README.
 */
function sendPushToAll(message, excludePerson) {
  if (!FCM_SERVER_KEY || FCM_SERVER_KEY === 'YOUR_FCM_SERVER_KEY_HERE') {
    Logger.log('[FCM] Server key not configured. Skipping push notification.');
    return;
  }

  const tokenSheet = getSheet('tokens');
  const tokenRows = sheetToObjects(tokenSheet);

  const tokens = tokenRows
    .filter(r => r.token && String(r.person).trim() !== String(excludePerson).trim())
    .map(r => String(r.token).trim());

  if (tokens.length === 0) {
    Logger.log('[FCM] No tokens to notify');
    return;
  }

  // Send in batches of 500 (FCM limit per request)
  const batchSize = 500;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    sendFCMBatch(batch, message);
  }
}

function sendFCMBatch(tokens, message) {
  const payload = {
    registration_ids: tokens,
    notification: {
      title: 'Net Positive 💪',
      body: message,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
    },
    data: {
      url: '/',
      message: message,
    },
    priority: 'high',
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'key=' + FCM_SERVER_KEY,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch('https://fcm.googleapis.com/fcm/send', options);
    const result = JSON.parse(response.getContentText());
    Logger.log('[FCM] Batch sent. Success: %s, Failure: %s', result.success, result.failure);

    // Clean up invalid tokens
    if (result.results) {
      cleanupInvalidTokens(tokens, result.results);
    }
  } catch (err) {
    Logger.log('[FCM] Error sending push: %s', err.message);
  }
}

function cleanupInvalidTokens(tokens, results) {
  const invalidTokens = [];
  results.forEach((result, i) => {
    if (result.error === 'NotRegistered' || result.error === 'InvalidRegistration') {
      invalidTokens.push(tokens[i]);
    }
  });

  if (invalidTokens.length === 0) return;

  const sheet = getSheet('tokens');
  const data = sheet.getDataRange().getValues();

  // Delete invalid token rows (iterate in reverse to preserve row indices)
  for (let i = data.length - 1; i >= 1; i--) {
    if (invalidTokens.includes(String(data[i][0]).trim())) {
      sheet.deleteRow(i + 1);
    }
  }
  Logger.log('[FCM] Cleaned up %s invalid tokens', invalidTokens.length);
}

// ============================================================
// UTILITY
// ============================================================

function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Test function — run manually in Apps Script editor to verify setup.
 * Go to Run > Run function > testSetup
 */
function testSetup() {
  // Create all sheets if they don't exist
  getSheet('completions');
  getSheet('participants');
  getSheet('tokens');
  Logger.log('✅ All sheets created/verified.');

  // Test adding a participant
  const testResult = handleAddParticipant({
    name: 'Test User',
    pin: '1234',
    colorIndex: 0,
  });
  Logger.log('Add participant result: %s', JSON.stringify(testResult));

  // Test getting participants
  const getResult = handleGetParticipants();
  Logger.log('Get participants result: %s', getResult.getContent());

  // Clean up test user
  handleRemoveParticipant({ name: 'Test User' });
  Logger.log('✅ Test user cleaned up.');
}

/**
 * Scheduled trigger function — call this from a time-based trigger
 * to send morning reminder notifications (optional, not set up by default).
 *
 * To enable reminders:
 * 1. In Apps Script editor, go to Triggers (clock icon)
 * 2. Add trigger: sendDailyReminder, Time-driven, Day timer, 8:00-9:00 AM
 */
function sendDailyReminder() {
  // TODO: Implement daily reminder notifications
  // This function is here so it can be wired up to a trigger later
  // without refactoring the FCM integration.

  const tokenSheet = getSheet('tokens');
  const tokenRows = sheetToObjects(tokenSheet);
  const tokens = tokenRows.map(r => r.token).filter(Boolean);

  if (tokens.length === 0) {
    Logger.log('[Reminder] No tokens registered');
    return;
  }

  const message = "🏋️ Time to crush today's workout! 100 squats, 50 push-ups, 5 min plank.";

  // Send to all (no exclusion for reminders)
  sendFCMBatch(tokens, message);
  Logger.log('[Reminder] Sent to %s devices', tokens.length);
}
