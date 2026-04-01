/**
 * Net Positive Workout — Main App
 * Vanilla JS PWA for daily workout accountability
 * Backend: Firebase Firestore
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  getMessaging,
  getToken,
  onMessage,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js";
import { FIREBASE_CONFIG, VAPID_KEY as _VAPID_KEY } from "./config.js";

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  FIREBASE: FIREBASE_CONFIG,
  VAPID_KEY: _VAPID_KEY,

  // Exercises each person must complete daily
  EXERCISES: [
    { id: "squats", name: "100 Squats", emoji: "🦵", target: "100 reps" },
    { id: "pushups", name: "50 Push-ups", emoji: "💪", target: "50 reps" },
    { id: "plank", name: "5 Min Plank", emoji: "🧘", target: "5 minutes" },
  ],

  // Fine amounts
  FINE_PER_EXERCISE: 10,
  FINE_ALL_MISSED: 50,

  // History days
  HISTORY_DAYS: 7,

  // Challenge start/end dates (YYYY-MM-DD) — update or set via admin panel
  CHALLENGE_START_DATE: null,
  CHALLENGE_END_DATE: "2026-12-31",
};

// ============================================================
// FIREBASE INIT
// ============================================================

let db = null;
let messaging = null;

function initFirebase() {
  if (CONFIG.FIREBASE.apiKey === "YOUR_FIREBASE_API_KEY") {
    console.warn(
      "[Firebase] Not configured — update CONFIG.FIREBASE in app.js",
    );
    return false;
  }
  try {
    const app = initializeApp(CONFIG.FIREBASE);
    db = getFirestore(app);
    try {
      messaging = getMessaging(app);
      onMessage(messaging, (payload) => {
        const { title, body } = payload.notification || {};
        if (title) showToast(`${title}: ${body}`, "info", 5000);
      });
    } catch {
      // Messaging not supported in all environments (e.g. Firefox)
    }
    return true;
  } catch (err) {
    console.error("[Firebase] Init failed:", err.message);
    return false;
  }
}

// ============================================================
// PARTICIPANT COLORS
// ============================================================
const COLORS = [
  "#6c63ff",
  "#00d9a3",
  "#ff6b6b",
  "#ffd166",
  "#ff9f43",
  "#a29bfe",
  "#fd79a8",
  "#74b9ff",
];

// ============================================================
// STATE
// ============================================================
let state = {
  participants: [],
  completions: [],
  currentUser: null,
  todayStr: getTodayStr(),
  offlineQueue: [],
  cache: {},
  groupCelebratedToday: false,
};

// ============================================================
// UTILITIES
// ============================================================

function localISOString(date) {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const hh = pad(off / 60);
  const mm = pad(off % 60);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getLast7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  }
  return days;
}

function getAllDaysForParticipant(participant) {
  const start = participant.joinedDate || state.todayStr;
  const days = [];
  const d = new Date(start + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  while (d <= today) {
    days.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function calcBestStreak(name) {
  const participant = state.participants.find((p) => p.name === name);
  const stored = participant?.bestStreak ?? 0;
  return Math.max(stored, calcStreak(name));
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function calcStreak(name) {
  const participant = state.participants.find((p) => p.name === name);
  if (!participant) return 0;
  const base = participant.currentStreak ?? 0;
  if (isWorkoutComplete(name, state.todayStr)) return base + 1;
  if (isSickDay(name, state.todayStr)) return base; // paused: no increment, no reset
  return base;
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function getParticipantColor(participant) {
  return COLORS[participant.colorIndex % COLORS.length];
}

function getInitials(name) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function avatarHTML(participant, className) {
  const color = getParticipantColor(participant);
  if (participant.avatar) {
    return `<div class="${className}" style="background:${color};padding:0;overflow:hidden;"><img src="${participant.avatar}" style="width:100%;height:100%;object-fit:cover;" alt="${participant.name}"></div>`;
  }
  return `<div class="${className}" style="background:${color};">${getInitials(participant.name)}</div>`;
}

function resizeImageToBase64(file, size = 80, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const min = Math.min(img.width, img.height);
      const sx = (img.width - min) / 2;
      const sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function saveAvatar() {
  const fileInput = document.getElementById("avatar-file-input");
  const file = fileInput.files[0];
  if (!file) return;
  const btn = document.getElementById("btn-save-avatar");
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    const base64 = await resizeImageToBase64(file);
    await updateDoc(doc(db, "participants", state.currentUser.name), {
      avatar: base64,
    });
    state.currentUser.avatar = base64;
    const p = state.participants.find((p) => p.name === state.currentUser.name);
    if (p) p.avatar = base64;
    closeModal("avatar-modal");
    renderHeader();
    renderCurrentView();
    showToast("Profile photo updated", "success");
  } catch (err) {
    showToast("Failed to save photo: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Photo";
  }
}

let changePinStep = "new"; // "new" | "confirm"
let changePinNew = "";
let changePinConfirm = "";

function updateChangePinDots() {
  const buf = changePinStep === "new" ? changePinNew : changePinConfirm;
  document.querySelectorAll("#change-pin-dots .pin-dot").forEach((dot, i) => {
    dot.classList.toggle("filled", i < buf.length);
  });
}

function handleChangePinKey(digit) {
  clearChangePinError();
  if (changePinStep === "new") {
    if (changePinNew.length >= 4) return;
    changePinNew += digit;
    updateChangePinDots();
    if (changePinNew.length === 4) setTimeout(advanceChangePinStep, 100);
  } else {
    if (changePinConfirm.length >= 4) return;
    changePinConfirm += digit;
    updateChangePinDots();
    if (changePinConfirm.length === 4) setTimeout(submitChangePin, 100);
  }
}

function handleChangePinBack() {
  if (changePinStep === "new") {
    changePinNew = changePinNew.slice(0, -1);
  } else {
    changePinConfirm = changePinConfirm.slice(0, -1);
  }
  updateChangePinDots();
}

function handleChangePinClear() {
  if (changePinStep === "new") changePinNew = "";
  else changePinConfirm = "";
  updateChangePinDots();
}

function advanceChangePinStep() {
  changePinStep = "confirm";
  changePinConfirm = "";
  document.getElementById("change-pin-title").textContent = "Confirm PIN";
  updateChangePinDots();
}

function showChangePinError(msg) {
  const errorEl = document.getElementById("change-pin-error");
  errorEl.textContent = msg;
  errorEl.style.display = "block";
}

function clearChangePinError() {
  const errorEl = document.getElementById("change-pin-error");
  errorEl.textContent = "";
  errorEl.style.display = "none";
}

async function submitChangePin() {
  if (changePinNew !== changePinConfirm) {
    showChangePinError("PINs don't match — try again");
    changePinStep = "new";
    changePinNew = "";
    changePinConfirm = "";
    document.getElementById("change-pin-title").textContent = "New PIN";
    updateChangePinDots();
    return;
  }
  try {
    await updateDoc(doc(db, "participants", state.currentUser.name), {
      pin: changePinNew,
    });
    state.currentUser.pin = changePinNew;
    const p = state.participants.find((p) => p.name === state.currentUser.name);
    if (p) p.pin = changePinNew;
    closeModal("change-pin-modal");
    showToast("PIN updated", "success");
  } catch (err) {
    showChangePinError("Failed to save: " + err.message);
  }
}

async function removeAvatar() {
  const btn = document.getElementById("btn-remove-avatar");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "participants", state.currentUser.name), {
      avatar: null,
    });
    state.currentUser.avatar = null;
    const p = state.participants.find((p) => p.name === state.currentUser.name);
    if (p) p.avatar = null;
    closeModal("avatar-modal");
    renderHeader();
    renderCurrentView();
    showToast("Profile photo removed", "info");
  } catch (err) {
    showToast("Failed to remove photo: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function calcFinesForPerson(name, dates) {
  let total = 0;
  for (const date of dates) {
    if (date === state.todayStr) continue;
    if (isSickDay(name, date)) continue;
    const done = getCompletedExercisesForDay(name, date);
    const missed = CONFIG.EXERCISES.filter(
      (ex) => !done.includes(ex.id),
    ).length;
    if (missed === CONFIG.EXERCISES.length) total += CONFIG.FINE_ALL_MISSED;
    else total += missed * CONFIG.FINE_PER_EXERCISE;
  }
  return total;
}

function calcFinesForPersonAllTime(name) {
  const participant = state.participants.find((p) => p.name === name);
  if (!participant) return 0;
  const base = participant.storedFines ?? 0;
  const since = participant.finesThrough || participant.joinedDate;
  if (!since) return base;
  // Build every calendar day from `since` to yesterday — not just days with completion
  // records — so fully-missed days (no Firestore docs) are still counted as fines.
  const recentDates = [];
  const d = new Date(since + "T00:00:00");
  d.setDate(d.getDate() + 1); // start the day after `since`
  const end = new Date(state.todayStr + "T00:00:00");
  while (d < end) {
    recentDates.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
    d.setDate(d.getDate() + 1);
  }
  return base + calcFinesForPerson(name, recentDates);
}

function getCompletedExercisesForDay(name, date) {
  return state.completions
    .filter((c) => c.date === date && c.person === name && c.completed)
    .map((c) => c.exercise);
}

function isExerciseDone(personName, exerciseId, date) {
  return state.completions.some(
    (c) =>
      c.date === date &&
      c.person === personName &&
      c.exercise === exerciseId &&
      c.completed,
  );
}

function isWorkoutComplete(personName, date) {
  return CONFIG.EXERCISES.every((ex) =>
    isExerciseDone(personName, ex.id, date),
  );
}

function isSickDay(name, date) {
  const p = state.participants.find((p) => p.name === name);
  return Array.isArray(p?.sickDays) && p.sickDays.includes(date);
}

async function toggleSickDay(name, date) {
  const participant = state.participants.find((p) => p.name === name);
  if (!participant) return;
  const prev = Array.isArray(participant.sickDays)
    ? [...participant.sickDays]
    : [];
  const alreadySick = prev.includes(date);
  const next = alreadySick ? prev.filter((d) => d !== date) : [...prev, date];

  // Optimistic update
  participant.sickDays = next;
  if (state.currentUser?.name === name) state.currentUser.sickDays = next;

  try {
    await updateDoc(doc(db, "participants", name), { sickDays: next });
    rebuildCache();
    renderCurrentView();
    showToast(
      alreadySick
        ? "Sick day removed"
        : "Sick day marked — no fines, streak held",
      "info",
    );
  } catch (err) {
    // Roll back
    participant.sickDays = prev;
    if (state.currentUser?.name === name) state.currentUser.sickDays = prev;
    showToast("Failed to update: " + err.message, "error");
  }
}

function getWorkoutCompletionTime(personName, date) {
  if (!isWorkoutComplete(personName, date)) return null;
  const timestamps = state.completions
    .filter(
      (c) =>
        c.date === date &&
        c.person === personName &&
        c.completed &&
        c.completedAt,
    )
    .map((c) => new Date(c.completedAt).getTime())
    .filter((t) => !isNaN(t));
  if (!timestamps.length) return null;
  const latest = new Date(Math.max(...timestamps));
  return latest.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// ============================================================
// FIRESTORE DATA LAYER
// ============================================================

function rebuildCache() {
  state.cache = {};
  for (const p of state.participants) {
    state.cache[p.name] = {
      fines: calcFinesForPersonAllTime(p.name),
      streak: calcStreak(p.name),
      bestStreak: calcBestStreak(p.name),
    };
  }
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getYesterdayForOffset(offsetMinutes) {
  const now = new Date();
  // Shift to participant's local time using their stored UTC offset
  // getTimezoneOffset() is minutes west of UTC: UTC+8 = -480, UTC = 0
  const local = new Date(now.getTime() - offsetMinutes * 60000);
  local.setUTCDate(local.getUTCDate() - 1);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

async function advanceFineCheckpoints() {
  if (!db) return;
  // Each participant's fines are advanced using their own stored timezone offset,
  // so no device can prematurely fine someone in a different timezone.
  for (const p of state.participants) {
    const yesterday = getYesterdayForOffset(p.timezoneOffset ?? -480);
    const through = p.finesThrough || p.joinedDate || yesterday;
    if (through >= yesterday) continue; // already up to date

    // Build every calendar day from `through` to yesterday — not just days with
    // completion records — so fully-missed days are correctly counted as fines.
    const newDates = [];
    const _d = new Date(through + "T00:00:00");
    _d.setDate(_d.getDate() + 1); // start day after `through`
    const _end = new Date(yesterday + "T00:00:00");
    while (_d <= _end) {
      newDates.push(
        `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`,
      );
      _d.setDate(_d.getDate() + 1);
    }

    let streak = p.currentStreak ?? 0;
    let addedFines = 0;

    for (const date of newDates) {
      if (isWorkoutComplete(p.name, date)) {
        streak++;
      } else if (isSickDay(p.name, date)) {
        // sick day: no fine, streak pauses (no increment, no reset)
      } else {
        const done = getCompletedExercisesForDay(p.name, date);
        const missed = CONFIG.EXERCISES.filter(
          (ex) => !done.includes(ex.id),
        ).length;
        addedFines +=
          missed === CONFIG.EXERCISES.length
            ? CONFIG.FINE_ALL_MISSED
            : missed * CONFIG.FINE_PER_EXERCISE;
        streak = 0;
      }
    }

    const updates = {
      storedFines: (p.storedFines ?? 0) + addedFines,
      finesThrough: yesterday,
      currentStreak: streak,
      bestStreak: Math.max(p.bestStreak ?? 0, streak),
    };

    try {
      await updateDoc(doc(db, "participants", p.name), updates);
      Object.assign(p, updates);
    } catch (err) {
      console.warn("[Checkpoint] Failed to advance for", p.name, err.message);
    }
  }

  rebuildCache();
}

async function syncAggregates() {
  const btn = document.getElementById("btn-sync-aggregates");
  btn.disabled = true;
  btn.textContent = "Syncing...";
  try {
    const snap = await getDocs(collection(db, "completions"));
    const allCompletions = snap.docs.map((d) => d.data());

    // Temporarily use full history for calculations
    const saved = state.completions;
    state.completions = allCompletions;

    for (const p of state.participants) {
      // Use each participant's own timezone offset so the cutoff date is correct
      const yesterday = getYesterdayForOffset(p.timezoneOffset ?? -480);

      // Generate every calendar day from joinedDate to yesterday so fully-missed
      // days (no Firestore docs) are counted as fines, consistent with history view.
      const allDates = [];
      const syncStart = p.joinedDate || yesterday;
      if (syncStart) {
        const _d = new Date(syncStart + "T00:00:00");
        const _end = new Date(yesterday + "T00:00:00");
        while (_d <= _end) {
          allDates.push(
            `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`,
          );
          _d.setDate(_d.getDate() + 1);
        }
      }

      // Re-pin state.completions in case the onSnapshot fired during a previous
      // participant's await updateDoc and replaced it with the 90-day window.
      state.completions = allCompletions;

      let bestStreak = 0;
      let currentStreak = 0;

      for (const date of allDates) {
        if (isWorkoutComplete(p.name, date)) {
          currentStreak++;
          bestStreak = Math.max(bestStreak, currentStreak);
        } else if (isSickDay(p.name, date)) {
          // sick day: streak pauses (no increment, no reset)
        } else {
          currentStreak = 0;
        }
      }

      // Use the same calcFinesForPerson logic as history so the values always match
      const storedFines = calcFinesForPerson(p.name, allDates);

      const updates = {
        storedFines,
        finesThrough: yesterday,
        currentStreak,
        bestStreak,
      };
      await updateDoc(doc(db, "participants", p.name), updates);
      Object.assign(p, updates);
    }

    state.completions = saved;
    rebuildCache();
    showToast("Aggregates synced! Reads will now be minimal.", "success");
  } catch (err) {
    showToast("Sync failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync Aggregates";
  }
}

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "app"));
    if (snap.exists()) {
      const data = snap.data();
      if (data.challengeEndDate)
        CONFIG.CHALLENGE_END_DATE = data.challengeEndDate;
      if (data.challengeStartDate)
        CONFIG.CHALLENGE_START_DATE = data.challengeStartDate;
    }
  } catch (err) {
    console.warn("[Settings] Failed to load settings:", err.message);
  }
}

async function saveStartDate() {
  const input = document.getElementById("admin-start-date");
  const val = input.value;
  if (!val) {
    showToast("Please enter a valid date", "error");
    return;
  }
  const btn = document.getElementById("btn-save-start-date");
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    await setDoc(
      doc(db, "settings", "app"),
      { challengeStartDate: val },
      { merge: true },
    );
    CONFIG.CHALLENGE_START_DATE = val;
    showToast("Start date updated", "success");
    renderLeaderboard();
  } catch (err) {
    showToast("Failed to save: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Start Date";
  }
}

async function saveEndDate() {
  const input = document.getElementById("admin-end-date");
  const val = input.value;
  if (!val) {
    showToast("Please enter a valid date", "error");
    return;
  }
  const btn = document.getElementById("btn-save-end-date");
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    await setDoc(
      doc(db, "settings", "app"),
      { challengeEndDate: val },
      { merge: true },
    );
    CONFIG.CHALLENGE_END_DATE = val;
    showToast("End date updated", "success");
    renderLeaderboard();
  } catch (err) {
    showToast("Failed to save: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save End Date";
  }
}

function initListeners() {
  if (!db) throw new Error("Firebase not initialized");
  return new Promise((resolve, reject) => {
    let gotParticipants = false;
    let gotCompletions = false;
    let initialResolved = false;

    function onBothLoaded() {
      rebuildCache();
      if (!initialResolved) {
        initialResolved = true;
        resolve();
      } else {
        renderCurrentView();
      }
    }

    onSnapshot(
      collection(db, "participants"),
      (snap) => {
        state.participants = snap.docs.map((d) => d.data());
        gotParticipants = true;
        if (gotCompletions) onBothLoaded();
      },
      (err) => {
        if (!initialResolved) reject(err);
        else
          console.warn("[Firestore] participants listener error:", err.message);
      },
    );

    const ninetyDaysAgo = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();

    onSnapshot(
      query(collection(db, "completions"), where("date", ">=", ninetyDaysAgo)),
      (snap) => {
        state.completions = snap.docs.map((d) => d.data());
        gotCompletions = true;
        if (gotParticipants) onBothLoaded();
      },
      (err) => {
        if (!initialResolved) reject(err);
        else
          console.warn("[Firestore] completions listener error:", err.message);
      },
    );
  });
}

async function saveCompletion(personName, exerciseId, completed) {
  const item = {
    date: state.todayStr,
    person: personName,
    exercise: exerciseId,
    completed,
    completedAt: completed ? localISOString(new Date()) : null,
  };

  // Optimistic local update
  const idx = state.completions.findIndex(
    (c) =>
      c.date === item.date &&
      c.person === item.person &&
      c.exercise === item.exercise,
  );
  if (idx >= 0) state.completions[idx].completed = completed;
  else state.completions.push(item);

  const docId = `${item.date}_${personName}_${exerciseId}`;
  try {
    await setDoc(doc(db, "completions", docId), item);

    // Check if all exercises now done — send notification + group glory
    if (completed && isWorkoutComplete(personName, state.todayStr)) {
      sendCompletionNotification(personName);
      if (
        state.participants.every((p) =>
          isWorkoutComplete(p.name, state.todayStr),
        )
      ) {
        triggerGroupGlory();
      }
    }
  } catch (err) {
    state.offlineQueue.push({ docId, item });
    saveOfflineQueue();
    showToast("Saved offline — will sync when connected", "info");
  }
}

async function addParticipant(name, pin, isAdmin = false) {
  if (!db) throw new Error("Firebase not initialized");
  const colorIndex = state.participants.length % COLORS.length;
  const participant = {
    name,
    pin,
    colorIndex,
    joinedDate: getTodayStr(),
    isAdmin,
    timezoneOffset: new Date().getTimezoneOffset(),
  };
  await setDoc(doc(db, "participants", name), participant);
  state.participants.push(participant);
  return participant;
}

async function toggleAdmin(name, makeAdmin) {
  await updateDoc(doc(db, "participants", name), { isAdmin: makeAdmin });
  const p = state.participants.find((p) => p.name === name);
  if (p) p.isAdmin = makeAdmin;
}

async function removeParticipant(name) {
  if (!db) throw new Error("Firebase not initialized");
  await deleteDoc(doc(db, "participants", name));
  state.participants = state.participants.filter((p) => p.name !== name);
}

async function registerFCMToken(token) {
  if (!db) return;
  try {
    await setDoc(doc(db, "tokens", token), {
      token,
      person: state.currentUser?.name || "unknown",
      device: navigator.userAgent.slice(0, 80),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[FCM] Token registration failed:", err.message);
  }
}

async function sendCompletionNotification(personName) {
  try {
    // Read all tokens except the completing person's
    const tokensSnap = await getDocs(collection(db, "tokens"));
    const tokens = tokensSnap.docs
      .map((d) => d.data())
      .filter((t) => t.person !== personName)
      .map((t) => t.token);

    if (!tokens.length) return;

    // Send via Netlify Function (keeps FCM server key server-side)
    await fetch("/.netlify/functions/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `${personName} just completed today's workout!`,
        tokens,
      }),
    });
  } catch (err) {
    console.warn("[FCM] Notification failed:", err.message);
  }
}

// ============================================================
// OFFLINE QUEUE
// ============================================================

function saveOfflineQueue() {
  localStorage.setItem("np_offline_queue", JSON.stringify(state.offlineQueue));
}

function loadOfflineQueue() {
  try {
    const raw = localStorage.getItem("np_offline_queue");
    state.offlineQueue = raw ? JSON.parse(raw) : [];
  } catch {
    state.offlineQueue = [];
  }
}

async function flushOfflineQueue() {
  if (!db || !state.offlineQueue.length) return;
  const queue = [...state.offlineQueue];
  for (const { docId, item } of queue) {
    try {
      await setDoc(doc(db, "completions", docId), item);
      state.offlineQueue = state.offlineQueue.filter((q) => q.docId !== docId);
      saveOfflineQueue();
    } catch (err) {
      console.warn("[Offline] Failed to sync item:", err.message);
      break;
    }
  }
  if (!state.offlineQueue.length)
    showToast("Offline changes synced!", "success");
}

// ============================================================
// AUTH
// ============================================================

function loadCurrentUser() {
  try {
    const raw = localStorage.getItem("np_current_user");
    if (raw) state.currentUser = JSON.parse(raw);
  } catch {
    state.currentUser = null;
  }
}

function saveCurrentUser(user) {
  state.currentUser = user;
  localStorage.setItem("np_current_user", JSON.stringify(user));
}

function clearCurrentUser() {
  state.currentUser = null;
  localStorage.removeItem("np_current_user");
}

// ============================================================
// RENDER: AUTH SCREEN
// ============================================================

function renderAuthScreen() {
  const grid = document.getElementById("auth-participant-grid");
  grid.innerHTML = "";
  state.participants.forEach((p, i) => {
    const color = getParticipantColor(p);
    const btn = document.createElement("button");
    btn.className = "participant-btn";
    btn.dataset.index = i;
    btn.innerHTML = `
      ${avatarHTML(p, "participant-avatar")}
      <span>${p.name}</span>
    `;
    btn.addEventListener("click", () => startPINEntry(p));
    grid.appendChild(btn);
  });
}

let pinBuffer = "";
let pinTarget = null;

function startPINEntry(participant) {
  pinTarget = participant;
  pinBuffer = "";
  updatePinDots();
  document.getElementById("auth-pin-title").textContent =
    `${participant.name}'s PIN`;
  document.getElementById("auth-error").classList.remove("visible");
  showAuthStep("pin");
}

function updatePinDots() {
  document.querySelectorAll(".pin-dot").forEach((dot, i) => {
    dot.classList.toggle("filled", i < pinBuffer.length);
  });
}

function handlePinKey(digit) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += digit;
  updatePinDots();
  if (pinBuffer.length === 4) setTimeout(verifyPIN, 100);
}

function handlePinBack() {
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDots();
}

function handlePinClear() {
  pinBuffer = "";
  updatePinDots();
}

function verifyPIN() {
  if (!pinTarget) return;
  if (String(pinTarget.pin) === pinBuffer) {
    const tz = new Date().getTimezoneOffset();
    pinTarget.timezoneOffset = tz;
    saveCurrentUser(pinTarget);
    const pEntry = state.participants.find((p) => p.name === pinTarget.name);
    if (pEntry) pEntry.timezoneOffset = tz;
    updateDoc(doc(db, "participants", pinTarget.name), {
      timezoneOffset: tz,
    }).catch(() => {});
    document.getElementById("auth-error").classList.remove("visible");
    showApp();
  } else {
    document.getElementById("auth-error").classList.add("visible");
    pinBuffer = "";
    updatePinDots();
    const dotsEl = document.getElementById("pin-dots");
    const shake = [4, -4, 3, -3, 0];
    let i = 0;
    const interval = setInterval(() => {
      dotsEl.style.transform = `translateX(${shake[i] || 0}px)`;
      i++;
      if (i >= shake.length) {
        clearInterval(interval);
        dotsEl.style.transform = "";
      }
    }, 60);
  }
}

function showAuthStep(step) {
  document
    .getElementById("auth-step-select")
    .classList.toggle("hidden", step !== "select");
  document
    .getElementById("auth-step-pin")
    .classList.toggle("hidden", step !== "pin");
}

// ============================================================
// RENDER: TODAY VIEW
// ============================================================

function renderTodayView() {
  const container = document.getElementById("today-cards-container");
  container.innerHTML = "";

  const d = new Date();
  document.getElementById("today-date-label").textContent =
    d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

  const visibleParticipants = state.currentUser
    ? state.participants.filter((p) => p.name === state.currentUser.name)
    : state.participants;

  visibleParticipants.forEach((participant) => {
    const isMe =
      state.currentUser && state.currentUser.name === participant.name;
    const completedToday = getCompletedExercisesForDay(
      participant.name,
      state.todayStr,
    );
    const allDone = isWorkoutComplete(participant.name, state.todayStr);
    const sickToday = isSickDay(participant.name, state.todayStr);
    const color = getParticipantColor(participant);
    const initials = getInitials(participant.name);
    const streak =
      state.cache[participant.name]?.streak ?? calcStreak(participant.name);

    const card = document.createElement("div");
    card.className = `workout-card${isMe ? " is-me" : ""}${allDone ? " completed-all" : ""}${sickToday && !allDone ? " sick-today" : ""}`;
    card.id = `card-${participant.name.replace(/\s+/g, "-")}`;
    const cardAvatarHTML = avatarHTML(participant, "card-avatar");

    const exercisesHTML = CONFIG.EXERCISES.map((ex) => {
      const done = completedToday.includes(ex.id);
      return `
        <div class="exercise-item">
          <button class="exercise-check${done ? " checked" : ""}"
                  data-person="${participant.name}" data-exercise="${ex.id}"
                  ${!isMe || sickToday ? "disabled" : ""}
                  aria-label="${done ? "Uncheck" : "Check"} ${ex.name}"
                  title="${isMe ? (sickToday ? "Mark yourself as not sick to log exercises" : "") : "Log in as " + participant.name + " to check this"}">
          </button>
          <div class="exercise-info">
            <div class="exercise-name">${ex.name}</div>
            <div class="exercise-target">${ex.target}</div>
          </div>
          <span class="exercise-emoji">${ex.emoji}</span>
        </div>
      `;
    }).join("");

    const completionTime = allDone
      ? getWorkoutCompletionTime(participant.name, state.todayStr)
      : null;
    const statusText = allDone
      ? `🎉 All done!${completionTime ? ` · ${completionTime}` : ""}`
      : sickToday
        ? "🤒 Sick day — no fines"
        : `${completedToday.length}/${CONFIG.EXERCISES.length} completed`;

    card.innerHTML = `
      <div class="card-header">
        ${cardAvatarHTML}
        <div class="card-info">
          <div class="card-name">${participant.name}</div>
          <div class="card-status">${statusText}</div>
          ${streak > 0 ? `<div class="streak-pill">🔥 ${streak}-day streak</div>` : ""}
          ${isMe ? `<button class="sick-day-btn${sickToday ? " active" : ""}" data-person="${participant.name}">${sickToday ? "🤒 Sick Day" : "🤒 Sick?"}</button>` : ""}
        </div>
      </div>
      <div class="exercise-list">${exercisesHTML}</div>
      ${allDone ? '<div class="completion-banner">🎉 Workout Complete!</div>' : ""}
    `;

    if (isMe) {
      card.querySelectorAll(".exercise-check").forEach((btn) => {
        btn.addEventListener("click", handleExerciseCheck);
      });
      const sickBtn = card.querySelector(".sick-day-btn");
      if (sickBtn) {
        sickBtn.addEventListener("click", () =>
          toggleSickDay(participant.name, state.todayStr),
        );
      }
    }

    container.appendChild(card);
  });

  // Trigger group glory if all complete (handles onSnapshot updates + app open after completion)
  if (
    state.participants.length > 0 &&
    state.participants.every((p) => isWorkoutComplete(p.name, state.todayStr))
  ) {
    triggerGroupGlory();
  }

  // Group status summary (all participants except current user)
  const others = state.currentUser
    ? state.participants.filter((p) => p.name !== state.currentUser.name)
    : [];
  if (others.length > 0) {
    const summary = document.createElement("div");
    summary.className = "today-group-summary";

    const rows = others
      .map((p) => {
        const color = getParticipantColor(p);
        const done = getCompletedExercisesForDay(p.name, state.todayStr);
        const isOtherSick = isSickDay(p.name, state.todayStr);
        const isOtherDone = isWorkoutComplete(p.name, state.todayStr);
        const exBadges =
          isOtherSick && !isOtherDone
            ? `<span class="gsm-sick-badge">🤒 sick</span>`
            : CONFIG.EXERCISES.map((ex) => {
                const isDone = done.includes(ex.id);
                return `<span class="gsm-ex ${isDone ? "done" : "pending"}">${ex.emoji}</span>`;
              }).join("");
        const completionTime = getWorkoutCompletionTime(p.name, state.todayStr);
        return `
        <div class="gsm-row">
          ${avatarHTML(p, "gsm-avatar")}
          <span class="gsm-name">${p.name}</span>
          <span class="gsm-time">${completionTime ?? ""}</span>
          <div class="gsm-exercises">${exBadges}</div>
        </div>
      `;
      })
      .join("");

    const allOthersDone = others.every((p) =>
      isWorkoutComplete(p.name, state.todayStr),
    );
    if (allOthersDone) summary.classList.add("all-done");
    summary.innerHTML = `<div class="gsm-label">Group Today</div>${rows}`;
    container.appendChild(summary);
  }
}

async function handleExerciseCheck(e) {
  const btn = e.currentTarget;
  const personName = btn.dataset.person;
  const exerciseId = btn.dataset.exercise;
  if (personName !== state.currentUser?.name) return;
  if (isSickDay(personName, state.todayStr)) return;

  const wasChecked = btn.classList.contains("checked");
  const nowChecked = !wasChecked;
  btn.classList.toggle("checked", nowChecked);

  const cardEl = btn.closest(".workout-card");
  const allChecked = [...cardEl.querySelectorAll(".exercise-check")].every(
    (b) => b.classList.contains("checked"),
  );

  const checkedCount = [...cardEl.querySelectorAll(".exercise-check.checked")]
    .length;

  if (allChecked && !cardEl.classList.contains("completed-all")) {
    cardEl.classList.add("completed-all", "just-completed");
    cardEl.querySelector(".card-status").textContent = "🎉 All done!";
    if (!cardEl.querySelector(".completion-banner")) {
      const banner = document.createElement("div");
      banner.className = "completion-banner";
      banner.textContent = "🎉 Workout Complete!";
      cardEl.appendChild(banner);
    }
    triggerConfetti(getParticipantColor(state.currentUser));
    setTimeout(() => cardEl.classList.remove("just-completed"), 600);
  } else if (!allChecked) {
    cardEl.classList.remove("completed-all");
    const banner = cardEl.querySelector(".completion-banner");
    if (banner) banner.remove();
    cardEl.querySelector(".card-status").textContent =
      `${checkedCount}/${CONFIG.EXERCISES.length} completed`;
  }

  try {
    await saveCompletion(personName, exerciseId, nowChecked);
  } catch {
    btn.classList.toggle("checked", wasChecked);
    showToast("Failed to save. Try again.", "error");
    return;
  }

  // Update streak pill after state.completions is updated by saveCompletion
  const streak = calcStreak(personName);
  const streakPill = cardEl.querySelector(".streak-pill");
  if (streak > 0) {
    if (!streakPill) {
      const pill = document.createElement("div");
      pill.className = "streak-pill";
      pill.textContent = `🔥 ${streak}-day streak`;
      cardEl
        .querySelector(".card-status")
        .insertAdjacentElement("afterend", pill);
    } else {
      streakPill.textContent = `🔥 ${streak}-day streak`;
    }
  } else {
    if (streakPill) streakPill.remove();
  }
}

// ============================================================
// RENDER: LEADERBOARD
// ============================================================

function renderLeaderboard() {
  const container = document.getElementById("leaderboard-container");
  container.innerHTML = "";

  const allDates = [...new Set(state.completions.map((c) => c.date))].sort();

  // Group pot and days remaining
  const groupPot = state.participants.reduce(
    (sum, p) =>
      sum + (state.cache[p.name]?.fines ?? calcFinesForPersonAllTime(p.name)),
    0,
  );
  const endDate = new Date(CONFIG.CHALLENGE_END_DATE + "T00:00:00");
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const daysRemaining = Math.max(
    0,
    Math.ceil((endDate - todayMidnight) / 86400000),
  );

  let secondStat;
  if (CONFIG.CHALLENGE_START_DATE) {
    const startDate = new Date(CONFIG.CHALLENGE_START_DATE + "T00:00:00");
    if (todayMidnight >= startDate) {
      const dayOf = Math.floor((todayMidnight - startDate) / 86400000) + 1;
      const totalDays = Math.max(
        1,
        Math.round((endDate - startDate) / 86400000) + 1,
      );
      secondStat = `
      <div class="board-stat">
        <div class="board-stat-value">${dayOf} <span style="font-size:0.85rem;opacity:0.6;">/ ${totalDays}</span></div>
        <div class="board-stat-label">📆 Day of Challenge</div>
      </div>`;
    }
  }
  if (!secondStat) {
    secondStat = `
      <div class="board-stat">
        <div class="board-stat-value">${daysRemaining}</div>
        <div class="board-stat-label">📅 Days Remaining</div>
      </div>`;
  }

  document.getElementById("board-stats").innerHTML = `
    <div class="board-stats-banner">
      <div class="board-stat">
        <div class="board-stat-value">$${groupPot}</div>
        <div class="board-stat-label">💰 Group Pot</div>
      </div>
      <div class="board-stat-divider"></div>
      ${secondStat}
    </div>
  `;

  const data = state.participants.map((p) => {
    const totalFines =
      state.cache[p.name]?.fines ?? calcFinesForPersonAllTime(p.name);
    const totalDays = allDates.filter((d) => d !== state.todayStr);
    const totalCompletions = totalDays.filter((d) =>
      isWorkoutComplete(p.name, d),
    ).length;
    const streak = state.cache[p.name]?.streak ?? calcStreak(p.name);
    const completionTimestamp = (() => {
      const ts = state.completions
        .filter((c) => c.person === p.name && c.completed && c.completedAt)
        .map((c) => new Date(c.completedAt).getTime())
        .filter((t) => !isNaN(t));
      return ts.length ? Math.max(...ts) : 0;
    })();

    return {
      participant: p,
      totalFines,
      totalCompletions,
      streak,
      completionTimestamp,
    };
  });

  data.sort((a, b) => {
    if (a.totalFines !== b.totalFines) return a.totalFines - b.totalFines;
    if (a.streak !== b.streak) return b.streak - a.streak;
    if (!a.completionTimestamp && !b.completionTimestamp) return 0;
    if (!a.completionTimestamp) return 1; // not completed today → goes after
    if (!b.completionTimestamp) return -1;
    return a.completionTimestamp - b.completionTimestamp; // earlier finish → first
  });

  const rankEmojis = ["🥇", "🥈", "🥉"];
  const rankClasses = ["gold", "silver", "bronze"];
  const allDaysExceptToday = allDates.filter((d) => d !== state.todayStr);

  // Assign ranks — tied scores share the same rank
  data.forEach((entry, i) => {
    if (i === 0) {
      entry.rank = 1;
    } else {
      const prev = data[i - 1];
      const tied =
        entry.totalFines === prev.totalFines && entry.streak === prev.streak;
      entry.rank = tied ? prev.rank : i + 1;
    }
  });

  data.forEach((entry, i) => {
    const { participant, totalFines, totalCompletions, streak, rank } = entry;
    const color = getParticipantColor(participant);
    const fineDisplay = totalFines === 0 ? "$0" : `-$${totalFines}`;
    const fineClass = totalFines === 0 ? "zero" : "";
    const rate =
      allDaysExceptToday.length > 0
        ? Math.round((totalCompletions / allDaysExceptToday.length) * 100)
        : 0;
    const rankDisplay = rank <= 3 ? rankEmojis[rank - 1] : rank;
    const rankClass = rank <= 3 ? rankClasses[rank - 1] : "";

    const item = document.createElement("div");
    item.className = `leaderboard-item${rank === 1 ? " rank-first" : ""}`;
    item.innerHTML = `
      <div class="rank-badge ${rankClass}">${rankDisplay}</div>
      ${avatarHTML(participant, "leaderboard-avatar")}
      <div class="leaderboard-info">
        <div class="leaderboard-name">${participant.name}</div>
        <div class="leaderboard-stats">
          ${streak > 0 ? `<span class="stat-pill streak">🔥 ${streak} streak</span>` : ""}
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width:${rate}%;background:${color};"></div>
        </div>
      </div>
      <div class="leaderboard-fine">
        <div class="lb-fine-amount ${fineClass}">${fineDisplay}</div>
        <div class="lb-fine-label">fines</div>
      </div>
    `;
    container.appendChild(item);
  });
}

// ============================================================
// RENDER: HISTORY
// ============================================================

async function renderHistory() {
  const container = document.getElementById("history-container");
  container.innerHTML = "";

  // Cap history display to the 90-day window already in memory
  const ninetyDaysAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  state.participants.forEach((participant) => {
    const color = getParticipantColor(participant);
    const windowStart =
      (participant.joinedDate || ninetyDaysAgo) > ninetyDaysAgo
        ? participant.joinedDate || ninetyDaysAgo
        : ninetyDaysAgo;
    const allDays = (() => {
      const days = [];
      const d = new Date(windowStart + "T00:00:00");
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      while (d <= today) {
        days.push(
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        );
        d.setDate(d.getDate() + 1);
      }
      return days;
    })();

    // Summary stats — use stored aggregates for all-time fines/streaks
    const totalFines = calcFinesForPersonAllTime(participant.name);
    const streak = calcStreak(participant.name);
    const bestStreak = calcBestStreak(participant.name);
    const pastDays = allDays.filter((d) => d < state.todayStr);
    const todayDone = isWorkoutComplete(participant.name, state.todayStr);
    const completedDays =
      pastDays.filter((d) => isWorkoutComplete(participant.name, d)).length +
      (todayDone ? 1 : 0);
    const totalCountedDays = pastDays.length + (todayDone ? 1 : 0);
    const completionRate =
      totalCountedDays > 0
        ? Math.round((completedDays / totalCountedDays) * 100)
        : 100;

    // Date label without month (used inside month sections)
    const fmtDay = (dateStr) => {
      const d = new Date(dateStr + "T00:00:00");
      return d.toLocaleDateString("en-US", {
        weekday: "short",
        day: "numeric",
      });
    };

    // Group days by month (YYYY-MM)
    const monthMap = {};
    for (const date of allDays) {
      const monthKey = date.slice(0, 7);
      if (!monthMap[monthKey]) monthMap[monthKey] = [];
      monthMap[monthKey].push(date);
    }
    const monthKeys = Object.keys(monthMap).sort().reverse(); // newest first

    // Build months HTML
    let monthsHTML = "";
    for (const monthKey of monthKeys) {
      const monthDays = monthMap[monthKey].slice().reverse(); // newest first within month
      const monthFine = calcFinesForPerson(participant.name, monthDays);
      const monthDate = new Date(monthKey + "-01T00:00:00");
      const monthLabel = monthDate.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });

      let daysHTML = "";
      for (const date of monthDays) {
        const isToday = date === state.todayStr;
        const isSick = isSickDay(participant.name, date);
        const allComplete = isWorkoutComplete(participant.name, date);
        const done = getCompletedExercisesForDay(participant.name, date);
        const exBadges = CONFIG.EXERCISES.map((ex) => {
          const isDone = done.includes(ex.id);
          if (isSick && !isDone)
            return `<span class="history-ex-badge sick">${ex.emoji}</span>`;
          if (isToday && !isDone)
            return `<span class="history-ex-badge pending">${ex.emoji}</span>`;
          return `<span class="history-ex-badge ${isDone ? "done" : "missed"}">${ex.emoji}</span>`;
        }).join("");

        let dayFine = 0;
        if (!isToday && !isSick) {
          const missed = CONFIG.EXERCISES.filter(
            (ex) => !done.includes(ex.id),
          ).length;
          dayFine =
            missed === CONFIG.EXERCISES.length
              ? CONFIG.FINE_ALL_MISSED
              : missed * CONFIG.FINE_PER_EXERCISE;
        }

        daysHTML += `
          <div class="history-day${isSick && !allComplete ? " sick-day-row" : ""}">
            <div class="history-date">${fmtDay(date)}</div>
            <div class="history-exercises">${exBadges}</div>
            ${
              isSick && !allComplete
                ? `<div class="history-fine-day sick-label">🤒</div>`
                : isToday
                  ? `<div class="history-fine-day zero" style="font-size:0.7rem;">today</div>`
                  : `<div class="history-fine-day ${dayFine > 0 ? "" : "zero"}">${dayFine > 0 ? `-$${dayFine}` : "$0"}</div>`
            }
          </div>
        `;
      }

      monthsHTML += `
        <div class="history-month">
          <div class="history-month-header">
            <span class="history-month-label">${monthLabel}</span>
            <span class="history-month-fine ${monthFine === 0 ? "zero" : ""}">${monthFine > 0 ? `-$${monthFine}` : "$0"}</span>
            <span class="history-month-chevron">▾</span>
          </div>
          <div class="history-month-days"><div class="history-month-days-inner">${daysHTML}</div></div>
        </div>
      `;
    }

    const section = document.createElement("div");
    section.className = "history-person";
    section.innerHTML = `
      <div class="history-person-header">
        ${avatarHTML(participant, "history-avatar")}
        <div><div class="history-name">${participant.name}</div></div>
        <span class="history-chevron"></span>
      </div>
      <div class="history-summary">
        <div class="history-summary-stat">
          <div class="history-summary-value" style="color:var(--danger);">-$${totalFines}</div>
          <div class="history-summary-label">Fines</div>
        </div>
        <div class="history-summary-stat">
          <div class="history-summary-value" style="color:var(--warning);">${streak}</div>
          <div class="history-summary-label">Streak</div>
        </div>
        <div class="history-summary-stat">
          <div class="history-summary-value" style="color:var(--warning);">${bestStreak}</div>
          <div class="history-summary-label">Best</div>
        </div>
        <div class="history-summary-stat">
          <div class="history-summary-value" style="color:var(--success);">${completedDays}</div>
          <div class="history-summary-label">Days</div>
        </div>
        <div class="history-summary-stat">
          <div class="history-summary-value" style="color:var(--success);">${completionRate}%</div>
          <div class="history-summary-label">Rate</div>
        </div>
      </div>
      <div class="history-days"><div class="history-days-inner">${monthsHTML}</div></div>
    `;

    container.appendChild(section);

    const daysEl = section.querySelector(".history-days");

    // Month accordions
    section.querySelectorAll(".history-month").forEach((monthEl) => {
      const monthDaysEl = monthEl.querySelector(".history-month-days");
      monthEl
        .querySelector(".history-month-header")
        .addEventListener("click", () => {
          const expanded = monthEl.classList.contains("expanded");
          if (expanded) {
            monthDaysEl.style.height = monthDaysEl.scrollHeight + "px";
            requestAnimationFrame(() => {
              monthDaysEl.style.height = "0";
            });
            monthEl.classList.remove("expanded");
          } else {
            monthEl.classList.add("expanded");
            monthDaysEl.style.height = monthDaysEl.scrollHeight + "px";
            monthDaysEl.addEventListener(
              "transitionend",
              () => {
                if (monthEl.classList.contains("expanded"))
                  monthDaysEl.style.height = "auto";
              },
              { once: true },
            );
          }
        });
    });

    // Person card accordion — overflow:visible after open so months aren't clipped
    section
      .querySelector(".history-person-header")
      .addEventListener("click", () => {
        const expanded = section.classList.contains("expanded");
        if (expanded) {
          daysEl.style.overflow = "hidden";
          daysEl.style.height = daysEl.scrollHeight + "px";
          requestAnimationFrame(() => {
            daysEl.style.height = "0";
          });
          section.classList.remove("expanded");
        } else {
          section.classList.add("expanded");
          daysEl.style.height = daysEl.scrollHeight + "px";
          daysEl.addEventListener(
            "transitionend",
            () => {
              if (section.classList.contains("expanded")) {
                daysEl.style.height = "auto";
                daysEl.style.overflow = "visible";
              }
            },
            { once: true },
          );
        }
      });
  });
}

// ============================================================
// RENDER: ADMIN
// ============================================================

function renderAdmin() {
  const totalFines = state.participants.reduce(
    (sum, p) =>
      sum + (state.cache[p.name]?.fines ?? calcFinesForPersonAllTime(p.name)),
    0,
  );
  document.getElementById("total-pot-amount").textContent = `$${totalFines}`;

  const list = document.getElementById("admin-participants-list");
  list.innerHTML = "";
  state.participants.forEach((p) => {
    const color = getParticipantColor(p);
    const fine =
      state.cache[p.name]?.fines ?? calcFinesForPersonAllTime(p.name);
    const row = document.createElement("div");
    row.className = "participant-admin-row";
    row.innerHTML = `
      ${avatarHTML(p, "admin-avatar")}
      <span class="admin-name">${p.name}${p.isAdmin ? ' <span style="font-size:0.65rem;background:rgba(108,99,255,0.2);color:var(--accent);padding:2px 6px;border-radius:4px;font-weight:700;">ADMIN</span>' : ""}</span>
      <span style="font-size:0.8rem;color:var(--danger);font-weight:700;font-family:var(--font-mono);">
        ${fine > 0 ? `-$${fine}` : "$0"}
      </span>
      <button class="btn-secondary" style="padding:6px 10px;font-size:0.72rem;" data-toggle-admin="${p.name}" data-is-admin="${p.isAdmin ? "1" : "0"}">
        ${p.isAdmin ? "Revoke Admin" : "Make Admin"}
      </button>
      <button class="btn-danger" style="padding:6px 10px;font-size:0.75rem;" data-remove="${p.name}">Remove</button>
    `;
    row
      .querySelector("[data-remove]")
      .addEventListener("click", () => confirmRemoveParticipant(p.name));
    row
      .querySelector("[data-toggle-admin]")
      .addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const targetName = btn.dataset.toggleAdmin;
        const makeAdmin = btn.dataset.isAdmin !== "1";
        btn.disabled = true;
        try {
          await toggleAdmin(targetName, makeAdmin);
          showToast(
            `${targetName} is ${makeAdmin ? "now an admin" : "no longer an admin"}`,
            "success",
          );
          renderAdmin();
        } catch (err) {
          showToast("Failed to update admin status", "error");
        } finally {
          btn.disabled = false;
        }
      });
    list.appendChild(row);
  });

  const startDateInput = document.getElementById("admin-start-date");
  if (startDateInput) startDateInput.value = CONFIG.CHALLENGE_START_DATE ?? "";
  const endDateInput = document.getElementById("admin-end-date");
  if (endDateInput) endDateInput.value = CONFIG.CHALLENGE_END_DATE;

  const notifEl = document.getElementById("notif-status-text");
  if ("Notification" in window) {
    const s = Notification.permission;
    notifEl.textContent =
      s === "granted"
        ? "✅ Push notifications enabled on this device."
        : s === "denied"
          ? "❌ Notifications blocked. Update browser settings to enable."
          : "⚠️ Notifications not yet enabled. Tap below to enable.";
  } else {
    notifEl.textContent =
      "⚠️ This browser does not support push notifications.";
  }
}

// ============================================================
// RENDER: HEADER
// ============================================================

function renderHeader() {
  if (!state.currentUser) return;
  const color = getParticipantColor(state.currentUser);
  const avatarEl = document.getElementById("header-avatar");
  avatarEl.style.background = color;
  if (state.currentUser.avatar) {
    avatarEl.style.padding = "0";
    avatarEl.style.overflow = "hidden";
    avatarEl.innerHTML = `<img src="${state.currentUser.avatar}" style="width:100%;height:100%;object-fit:cover;" alt="${state.currentUser.name}">`;
  } else {
    avatarEl.style.padding = "";
    avatarEl.style.overflow = "";
    avatarEl.textContent = getInitials(state.currentUser.name);
  }
  document.getElementById("header-name").textContent = state.currentUser.name;
}

// ============================================================
// NAVIGATION
// ============================================================

function renderCurrentView() {
  if (!document.getElementById("auth-screen").classList.contains("hidden")) {
    renderAuthScreen();
    return;
  }
  if (document.getElementById("app").classList.contains("hidden")) return;
  const v = document.querySelector(".nav-item.active")?.dataset.view;
  switch (v) {
    case "today":
      renderTodayView();
      break;
    case "leaderboard":
      renderLeaderboard();
      break;
    case "history":
      renderHistory();
      break;
    case "admin":
      renderAdmin();
      break;
  }
}

function showView(viewId) {
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.remove("active"));
  document
    .querySelectorAll(".nav-item")
    .forEach((n) => n.classList.remove("active"));
  const viewEl = document.getElementById(`view-${viewId}`);
  if (viewEl) viewEl.classList.add("active");
  const navEl = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  if (navEl) navEl.classList.add("active");
  const floatAlan = document.getElementById("glory-alan-float");
  if (floatAlan) {
    floatAlan.style.display = (viewId === "leaderboard" || viewId === "history") ? "block" : "none";
  }

  switch (viewId) {
    case "today":
      renderTodayView();
      break;
    case "leaderboard":
      renderLeaderboard();
      break;
    case "history":
      renderHistory();
      break;
    case "admin":
      renderAdmin();
      break;
  }
}

// ============================================================
// MODALS
// ============================================================

function openModal(id) {
  document.getElementById(id).classList.add("open");
}
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

let removeTargetName = null;

function confirmRemoveParticipant(name) {
  removeTargetName = name;
  document.getElementById("remove-participant-name").textContent = name;
  openModal("remove-participant-modal");
}

// ============================================================
// TOAST
// ============================================================

function showToast(message, type = "", duration = 3000) {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast${type ? " " + type : ""}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================================
// CONFETTI
// ============================================================

function triggerConfetti(color = "#6c63ff") {
  const container = document.getElementById("confetti-container");
  const colors = [color, "#ffd166", "#00d9a3", "#ff6b6b", "#ffffff"];
  for (let i = 0; i < 50; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    const c = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 0.8;
    const duration = 2 + Math.random() * 1.5;
    const size = 6 + Math.random() * 8;
    piece.style.cssText = `left:${left}vw;background:${c};width:${size}px;height:${size}px;animation-delay:${delay}s;animation-duration:${duration}s;border-radius:${Math.random() > 0.5 ? "50%" : "2px"};`;
    container.appendChild(piece);
    setTimeout(() => piece.remove(), (delay + duration) * 1000 + 100);
  }
}

// ============================================================
// SQUAD GLORY CELEBRATION
// ============================================================

function hasGroupCelebratedToday() {
  return localStorage.getItem("np_group_glory") === state.todayStr;
}

function markGroupCelebratedToday() {
  state.groupCelebratedToday = true;
  localStorage.setItem("np_group_glory", state.todayStr);
}

function applyGloryAmbient() {
  document.getElementById("app").classList.add("group-glory-day");
  document.body.classList.add("group-glory-day");
  const todayHeader = document.querySelector("#view-today .view-header");
  if (todayHeader && !todayHeader.querySelector(".glory-today-alan")) {
    const img = document.createElement("img");
    img.className = "glory-today-alan";
    img.src = "/alan_heart.png";
    img.alt = "";
    todayHeader.appendChild(img);
  }
  if (!document.getElementById("glory-alan-float")) {
    const img = document.createElement("img");
    img.id = "glory-alan-float";
    img.src = "/alan_heart.png";
    img.alt = "";
    document.body.appendChild(img);
  }
}

function triggerGroupGlory() {
  if (hasGroupCelebratedToday()) {
    applyGloryAmbient();
    return;
  }
  markGroupCelebratedToday();
  applyGloryAmbient();
  launchMegaConfetti();
  launchFireworks();
  playVictoryFanfare();
  showGroupCompleteOverlay();
}

function launchMegaConfetti() {
  const canvas = document.createElement("canvas");
  canvas.id = "confetti-canvas";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:10001;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const colors = [...COLORS, "#ffd166", "#ffffff"];
  const pieces = [];

  const corners = [
    { x: 0, y: window.innerHeight, angleMin: 25, angleMax: 75 },
    {
      x: window.innerWidth,
      y: window.innerHeight,
      angleMin: 105,
      angleMax: 155,
    },
  ];

  corners.forEach(({ x, y, angleMin, angleMax }) => {
    for (let i = 0; i < 150; i++) {
      const angle =
        ((angleMin + Math.random() * (angleMax - angleMin)) * Math.PI) / 180;
      const speed = 8 + Math.random() * 10;
      pieces.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: -Math.sin(angle) * speed,
        color: colors[Math.floor(Math.random() * colors.length)],
        w: 6 + Math.random() * 8,
        h: 4 + Math.random() * 4,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.25,
        alpha: 1,
        delay: Math.random() * 0.5,
        born: false,
      });
    }
  });

  let frame = 0;
  let rafId;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const t = frame / 60;
    frame++;
    let alive = false;
    for (const p of pieces) {
      if (t < p.delay) {
        alive = true;
        continue;
      }
      p.born = true;
      p.vy += 0.28;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.rotSpeed;
      if (p.y > canvas.height + 20) p.alpha -= 0.06;
      if (p.alpha <= 0) continue;
      alive = true;
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (alive) {
      rafId = requestAnimationFrame(draw);
    } else {
      canvas.remove();
    }
  }
  rafId = requestAnimationFrame(draw);
  setTimeout(() => {
    cancelAnimationFrame(rafId);
    canvas.remove();
  }, 8000);
}

function launchFireworks() {
  const canvas = document.createElement("canvas");
  canvas.id = "fireworks-canvas";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const particles = [];
  const burstColors = [...COLORS];

  for (let b = 0; b < 8; b++) {
    const bx =
      0.1 * window.innerWidth + Math.random() * 0.8 * window.innerWidth;
    const by =
      0.1 * window.innerHeight + Math.random() * 0.6 * window.innerHeight;
    const color = burstColors[b % burstColors.length];
    const delay = b * 350;
    setTimeout(() => {
      for (let p = 0; p < 60; p++) {
        const angle = (p / 60) * Math.PI * 2;
        const speed = 2 + Math.random() * 4;
        particles.push({
          x: bx,
          y: by,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          alpha: 1,
          color,
          size: 3 + Math.random() * 3,
        });
      }
    }, delay);
  }

  let rafId;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.vy += 0.08;
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= 0.012;
      if (p.alpha <= 0) continue;
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (particles.some((p) => p.alpha > 0)) {
      rafId = requestAnimationFrame(draw);
    } else {
      canvas.remove();
    }
  }
  rafId = requestAnimationFrame(draw);
  setTimeout(() => {
    cancelAnimationFrame(rafId);
    canvas.remove();
  }, 6000);
}

function playVictoryFanfare() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "triangle";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.3, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  } catch {} // silently fail if audio blocked
}

function showGroupCompleteOverlay() {
  const existing = document.querySelector(".group-complete-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "group-complete-overlay";

  const avatarsHTML = state.participants
    .map((p, i) => {
      const color = getParticipantColor(p);
      const inner = p.avatar
        ? `<img src="${p.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="${p.name}">`
        : getInitials(p.name);
      return `
      <div class="glory-avatar-wrap" style="animation-delay:${i * 0.3}s">
        <div class="glory-avatar" style="background:${color};">${inner}</div>
        <div class="glory-name">${p.name.split(" ")[0]}</div>
      </div>`;
    })
    .join("");

  overlay.innerHTML = `
    <h1 class="glory-title">💪 SQUAD COMPLETE 💪</h1>
    <p class="glory-subtitle">Every single one of you showed up today.</p>
    <div class="glory-avatars">${avatarsHTML}</div>
    <p class="glory-dismiss">Tap anywhere to dismiss</p>
  `;

  document.body.appendChild(overlay);

  const dismiss = () => {
    overlay.style.transition = "opacity 0.4s";
    overlay.style.opacity = "0";
    setTimeout(() => overlay.remove(), 400);
  };
  overlay.addEventListener("click", dismiss);
  setTimeout(dismiss, 6000);
}

// ============================================================
// NOTIFICATIONS
// ============================================================

async function initNotifications() {
  if (!messaging || !("Notification" in window)) return;
  if (CONFIG.VAPID_KEY === "YOUR_VAPID_KEY_HERE") return;
  if (Notification.permission === "granted") await getFCMToken();
  else if (Notification.permission !== "denied") {
    document.getElementById("notif-banner").classList.remove("hidden");
  }
}

async function requestNotificationPermission() {
  if (!messaging) return;
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    document.getElementById("notif-banner").classList.add("hidden");
    await getFCMToken();
    showToast("Notifications enabled! 🔔", "success");
  } else {
    showToast("Notifications blocked.", "error");
  }
}

async function getFCMToken() {
  if (!messaging) return;
  try {
    const sw = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, {
      vapidKey: CONFIG.VAPID_KEY,
      serviceWorkerRegistration: sw,
    });
    if (token) await registerFCMToken(token);
  } catch (err) {
    console.warn("[FCM] getToken failed:", err.message);
  }
}

// ============================================================
// iOS PWA PROMPT
// ============================================================

function checkIOSInstallPrompt() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone;
  const dismissed = localStorage.getItem("np_ios_banner_dismissed");
  if (isIOS && !isStandalone && !dismissed) {
    document.getElementById("ios-install-banner").classList.remove("hidden");
  }
}

// ============================================================
// SERVICE WORKER
// ============================================================

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "SYNC_COMPLETIONS") flushOfflineQueue();
    });
  } catch (err) {
    console.warn("[SW] Registration failed:", err.message);
  }
}

// ============================================================
// ONLINE / OFFLINE
// ============================================================

function updateOnlineStatus() {
  const badge = document.getElementById("offline-badge");
  if (badge) badge.classList.toggle("hidden", navigator.onLine);
  if (navigator.onLine) flushOfflineQueue();
}

// ============================================================
// SCREEN MANAGEMENT
// ============================================================

function showScreen(name) {
  document
    .getElementById("loading-screen")
    .classList.toggle("hidden", name !== "loading");
  document
    .getElementById("auth-screen")
    .classList.toggle("hidden", name !== "auth");
  document
    .getElementById("setup-screen")
    .classList.toggle("hidden", name !== "setup");
  document.getElementById("app").classList.toggle("hidden", name !== "app");
}

function isCurrentUserAdmin() {
  if (!state.currentUser) return false;
  const p = state.participants.find((p) => p.name === state.currentUser.name);
  return p?.isAdmin === true;
}

function showApp() {
  showScreen("app");
  renderHeader();
  // Show admin tab only to admins
  const adminNav = document.querySelector('.nav-item[data-view="admin"]');
  if (adminNav) adminNav.classList.toggle("hidden", !isCurrentUserAdmin());
  showView("today");
  checkIOSInstallPrompt();
  initNotifications();
  advanceFineCheckpoints(); // fire-and-forget: advance stored aggregates to yesterday
}

// ============================================================
// EVENT BINDING
// ============================================================

function bindEvents() {
  document.getElementById("pin-keypad").addEventListener("click", (e) => {
    const key = e.target.closest(".pin-key");
    if (!key) return;
    if (key.dataset.digit !== undefined) handlePinKey(key.dataset.digit);
    else if (key.dataset.action === "back") handlePinBack();
    else if (key.dataset.action === "clear") handlePinClear();
  });

  document.getElementById("btn-auth-back").addEventListener("click", () => {
    pinBuffer = "";
    pinTarget = null;
    showAuthStep("select");
  });

  document
    .getElementById("btn-show-add-from-auth")
    .addEventListener("click", () => {
      clearModal();
      openModal("add-participant-modal");
    });

  document.getElementById("header-user-chip").addEventListener("click", () => {
    if (!state.currentUser) return;
    const fileInput = document.getElementById("avatar-file-input");
    fileInput.value = "";
    document.getElementById("avatar-preview").src =
      state.currentUser.avatar || "";
    document
      .getElementById("avatar-preview")
      .classList.toggle("hidden", !state.currentUser.avatar);
    document
      .getElementById("avatar-preview-placeholder")
      .classList.toggle("hidden", !!state.currentUser.avatar);
    document
      .getElementById("btn-remove-avatar")
      .classList.toggle("hidden", !state.currentUser.avatar);
    document.getElementById("btn-save-avatar").disabled = true;
    openModal("avatar-modal");
  });

  document
    .getElementById("avatar-file-input")
    .addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const preview = document.getElementById("avatar-preview");
      const placeholder = document.getElementById("avatar-preview-placeholder");
      preview.src = URL.createObjectURL(file);
      preview.classList.remove("hidden");
      placeholder.classList.add("hidden");
      document.getElementById("btn-save-avatar").disabled = false;
    });

  document
    .getElementById("btn-save-avatar")
    .addEventListener("click", saveAvatar);
  document
    .getElementById("btn-remove-avatar")
    .addEventListener("click", removeAvatar);
  document
    .getElementById("btn-cancel-avatar")
    .addEventListener("click", () => closeModal("avatar-modal"));
  document.getElementById("btn-change-pin").addEventListener("click", () => {
    changePinStep = "new";
    changePinNew = "";
    changePinConfirm = "";
    document.getElementById("change-pin-title").textContent = "New PIN";
    document.getElementById("change-pin-error").textContent = "";
    updateChangePinDots();
    closeModal("avatar-modal");
    openModal("change-pin-modal");
  });
  document
    .getElementById("change-pin-keypad")
    .addEventListener("click", (e) => {
      const key = e.target.closest(".pin-key");
      if (!key) return;
      if (key.dataset.digit !== undefined)
        handleChangePinKey(key.dataset.digit);
      else if (key.dataset.action === "back") handleChangePinBack();
      else if (key.dataset.action === "clear") handleChangePinClear();
    });
  document
    .getElementById("btn-cancel-pin")
    .addEventListener("click", () => closeModal("change-pin-modal"));

  document.getElementById("btn-switch-user").addEventListener("click", () => {
    clearCurrentUser();
    showScreen("auth");
    renderAuthScreen();
    showAuthStep("select");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !state.currentUser) return;
    const tz = new Date().getTimezoneOffset();
    if (tz === state.currentUser.timezoneOffset) return;
    state.currentUser.timezoneOffset = tz;
    const p = state.participants.find((p) => p.name === state.currentUser.name);
    if (p) p.timezoneOffset = tz;
    updateDoc(doc(db, "participants", state.currentUser.name), {
      timezoneOffset: tz,
    }).catch(() => {});
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  document
    .getElementById("btn-setup-submit")
    .addEventListener("click", handleSetupSubmit);
  document.getElementById("setup-pin").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSetupSubmit();
  });

  document
    .getElementById("btn-show-add-participant")
    .addEventListener("click", () => {
      clearModal();
      openModal("add-participant-modal");
    });

  document
    .getElementById("btn-add-participant-submit")
    .addEventListener("click", handleAddParticipant);
  document.getElementById("add-pin").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAddParticipant();
  });

  document
    .getElementById("btn-cancel-add")
    .addEventListener("click", () => closeModal("add-participant-modal"));
  document
    .getElementById("btn-confirm-remove")
    .addEventListener("click", handleRemoveParticipant);
  document
    .getElementById("btn-cancel-remove")
    .addEventListener("click", () => closeModal("remove-participant-modal"));

  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("open");
    });
  });

  document
    .getElementById("btn-enable-notifs")
    .addEventListener("click", requestNotificationPermission);
  document
    .getElementById("btn-admin-notifs")
    .addEventListener("click", requestNotificationPermission);

  document
    .getElementById("btn-seed-data")
    .addEventListener("click", () => seedTestData(60));

  document
    .getElementById("btn-reset-squad-glory")
    .addEventListener("click", () => {
      localStorage.removeItem("np_group_glory");
      state.groupCelebratedToday = false;
      showToast("Squad glory reset — will trigger again next completion", "success");
    });

  document
    .getElementById("btn-sync-aggregates")
    .addEventListener("click", syncAggregates);

  document
    .getElementById("btn-save-start-date")
    .addEventListener("click", saveStartDate);
  document
    .getElementById("btn-save-end-date")
    .addEventListener("click", saveEndDate);

  document.getElementById("ios-banner-close").addEventListener("click", () => {
    document.getElementById("ios-install-banner").classList.add("hidden");
    localStorage.setItem("np_ios_banner_dismissed", "1");
  });

  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
}

function clearModal() {
  document.getElementById("add-name").value = "";
  document.getElementById("add-pin").value = "";
  document.getElementById("add-error").textContent = "";
  document.getElementById("add-error").classList.remove("visible");
}

// ============================================================
// FORM HANDLERS
// ============================================================

async function handleSetupSubmit() {
  const name = document.getElementById("setup-name").value.trim();
  const pin = document.getElementById("setup-pin").value.trim();
  if (!name) {
    showSetupError("Please enter your name");
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    showSetupError("PIN must be exactly 4 digits");
    return;
  }

  const btn = document.getElementById("btn-setup-submit");
  btn.disabled = true;
  btn.textContent = "Adding...";
  try {
    // First participant to set up the app becomes admin automatically
    const p = await addParticipant(name, pin, true);
    saveCurrentUser(p);
    showApp();
  } catch (err) {
    showSetupError(err.message || "Failed to create account");
    btn.disabled = false;
    btn.textContent = "Create Account 🚀";
  }
}

function showSetupError(msg) {
  const el = document.getElementById("setup-error");
  el.textContent = msg;
  el.classList.add("visible");
}

async function handleAddParticipant() {
  const name = document.getElementById("add-name").value.trim();
  const pin = document.getElementById("add-pin").value.trim();
  if (!name) {
    showAddError("Enter a name");
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    showAddError("PIN must be exactly 4 digits");
    return;
  }
  if (
    state.participants.some((p) => p.name.toLowerCase() === name.toLowerCase())
  ) {
    showAddError("A participant with this name already exists");
    return;
  }

  const btn = document.getElementById("btn-add-participant-submit");
  btn.disabled = true;
  btn.textContent = "Adding...";
  try {
    await addParticipant(name, pin);
    closeModal("add-participant-modal");
    showToast(`${name} added! 💪`, "success");
    if (!document.getElementById("auth-screen").classList.contains("hidden"))
      renderAuthScreen();
    if (!document.getElementById("app").classList.contains("hidden")) {
      showView(
        document.querySelector(".nav-item.active")?.dataset.view || "today",
      );
    }
  } catch (err) {
    showAddError(err.message || "Failed to add participant");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add Participant";
  }
}

function showAddError(msg) {
  const el = document.getElementById("add-error");
  el.textContent = msg;
  el.classList.add("visible");
}

async function handleRemoveParticipant() {
  if (!removeTargetName) return;
  const name = removeTargetName;
  const btn = document.getElementById("btn-confirm-remove");
  btn.disabled = true;
  btn.textContent = "Removing...";
  try {
    await removeParticipant(name);
    closeModal("remove-participant-modal");
    showToast(`${name} removed`, "info");
    if (state.currentUser?.name === name) {
      clearCurrentUser();
      showScreen("auth");
      renderAuthScreen();
      showAuthStep("select");
    } else {
      renderAdmin();
    }
  } catch (err) {
    showToast(err.message || "Failed to remove participant", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Yes, Remove";
    removeTargetName = null;
  }
}

// ============================================================
// DEV: SEED TEST DATA
// ============================================================

async function seedTestData(daysBack = 60) {
  if (!db) {
    showToast("No database connection", "error");
    return;
  }
  if (!state.participants.length) {
    showToast("No participants found", "error");
    return;
  }

  const btn = document.getElementById("btn-seed-data");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Seeding…";
  }

  // Simple deterministic hash → 0..1 float
  function frac(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++)
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0) / 0xffffffff;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - daysBack);
  const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;

  // Push joinedDates back so history tab shows all days
  for (const p of state.participants) {
    if (!p.joinedDate || p.joinedDate > startStr) {
      p.joinedDate = startStr;
      await setDoc(doc(db, "participants", p.name), p);
    }
  }

  // Build all completion docs
  const writes = [];
  for (const p of state.participants) {
    const d = new Date(start);
    while (d < today) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dayRoll = frac(p.name + dateStr);

      for (const ex of CONFIG.EXERCISES) {
        let completed;
        if (dayRoll < 0.68) {
          completed = true; // ~68% fully-complete days
        } else if (dayRoll < 0.88) {
          completed = frac(p.name + dateStr + ex.id) < 0.5; // partial: 50/50 per exercise
        } else {
          completed = false; // ~12% total-miss days
        }
        writes.push({
          docId: `${dateStr}_${p.name}_${ex.id}`,
          item: { date: dateStr, person: p.name, exercise: ex.id, completed },
        });
      }
      d.setDate(d.getDate() + 1);
    }
  }

  showToast(`Writing ${writes.length} records…`, "info");

  // Write in parallel chunks of 50
  for (let i = 0; i < writes.length; i += 50) {
    await Promise.all(
      writes
        .slice(i, i + 50)
        .map(({ docId, item }) => setDoc(doc(db, "completions", docId), item)),
    );
  }

  showToast(
    `Seeded ${writes.length} records across ${daysBack} days!`,
    "success",
  );
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Seed Test Data (60 days)";
  }
  // onSnapshot listeners will pick up the new data and re-render automatically
}

// ============================================================
// INIT
// ============================================================

async function init() {
  showScreen("loading");

  const firebaseReady = initFirebase();
  if (!firebaseReady) {
    showScreen("setup");
    document.getElementById("setup-name").closest(".setup-card").innerHTML = `
      <p style="color:var(--danger);font-weight:700;text-align:center;padding:20px;">
        ⚠️ Firebase not configured.<br><br>
        <span style="color:var(--text-secondary);font-size:0.875rem;font-weight:400;">
          Open app.js and fill in CONFIG.FIREBASE with your Firebase project details.
          See README.md for setup instructions.
        </span>
      </p>
    `;
    return;
  }

  bindEvents();
  registerServiceWorker();
  loadOfflineQueue();
  loadCurrentUser();
  updateOnlineStatus();

  const urlParams = new URLSearchParams(window.location.search);
  const startView = urlParams.get("view");

  try {
    await Promise.all([initListeners(), loadSettings()]);
    advanceFineCheckpoints(); // pre-login: uses each participant's stored timezone offset
  } catch (err) {
    console.warn("[Firestore] Initial load failed:", err.message);
    showToast("Failed to load data. Check your connection.", "error");
    if (state.currentUser) {
      showApp();
      return;
    }
    showScreen("auth");
    renderAuthScreen();
    return;
  }

  if (state.participants.length === 0) {
    showScreen("setup");
    return;
  }

  if (state.currentUser) {
    const updated = state.participants.find(
      (p) => p.name === state.currentUser.name,
    );
    if (updated) {
      state.currentUser.colorIndex = updated.colorIndex;
      showApp();
      if (startView) showView(startView);
      return;
    }
    clearCurrentUser();
  }

  showScreen("auth");
  renderAuthScreen();
  showAuthStep("select");
}

// Day rollover check — update todayStr at midnight; onSnapshot keeps data fresh
setInterval(() => {
  const newDay = getTodayStr();
  if (newDay !== state.todayStr) {
    state.todayStr = newDay;
    state.groupCelebratedToday = false;
    document.getElementById("app").classList.remove("group-glory-day");
    document.body.classList.remove("group-glory-day");
    document.querySelector(".glory-today-alan")?.remove();
    document.getElementById("glory-alan-float")?.remove();
    advanceFineCheckpoints(); // advance stored aggregates before rebuilding cache
    rebuildCache();
    renderCurrentView();
  }
}, 60000);

document.addEventListener("DOMContentLoaded", init);
