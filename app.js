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
  arrayUnion,
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
    {
      id: "squats",
      name: "Squats",
      emoji: "🦵",
      target: "100 reps",
      targetCount: 100,
      unit: "reps",
      increment: 100,
    },
    {
      id: "pushups",
      name: "Push-ups",
      emoji: "💪",
      target: "50 reps",
      targetCount: 50,
      unit: "reps",
      increment: 50,
    },
    {
      id: "plank",
      name: "Pelvic Floor",
      emoji: "🤰",
      target: "5 minutes",
      targetCount: 5,
      unit: "min",
      increment: 5,
    },
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
  "#6c63ff", // blue (was indigo) — index 0
  "#00d9a3", // spring green (was teal) — index 1
  "#ff6b6b", // red (was coral) — index 2
  "#ffd166", // yellow — index 3
  "#ff9f43", // orange — index 4
  "#b58aff", // violet — index 5
  "#fd79a8", // rose (was pink) — index 6
  "#74b9ff", // azure (was sky blue) — index 7
  "#c4e85d", // chartreuse green
  "#6bd986", // green
  "#5fdde5", // cyan
  "#f070d0", // magenta
  "#f5f5fa", // white
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
  decree: null, // today's { date, dictator, pleb, quote } from Firestore (Dictator feature)
  reignPlebs: [], // names demoted on EARLIER days of the current reign (build up; reset at reign end)
  dictatorQuote: null, // sticky { text, by } from settings/app — persists across days
  chartRotated: (() => {
    try {
      return localStorage.getItem("np_chart_rotated") === "1";
    } catch {
      return false;
    }
  })(),
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

// ---- Completions split-window cache ----------------------------------------
// Completion docs are write-once on their own day (saveCompletion only ever
// writes date === today), so any day older than the volatile window never
// changes. We cache those stable docs in localStorage and only subscribe live
// to the recent days — turning a ~810-doc read on every load into ~70.
const COMPLETIONS_CACHE_KEY = "np_completions_cache";
const COMPLETIONS_CACHE_VERSION = 1;
const VOLATILE_DAYS = 7; // last N days are fetched live; older days come from cache

function dateStrDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysToDateStr(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadCompletionsCache() {
  try {
    const c = JSON.parse(localStorage.getItem(COMPLETIONS_CACHE_KEY));
    if (!c || c.version !== COMPLETIONS_CACHE_VERSION || !Array.isArray(c.docs))
      return null;
    return c; // { version, cachedThrough, docs }
  } catch {
    return null;
  }
}

function saveCompletionsCache(cachedThrough, docs) {
  try {
    localStorage.setItem(
      COMPLETIONS_CACHE_KEY,
      JSON.stringify({ version: COMPLETIONS_CACHE_VERSION, cachedThrough, docs }),
    );
  } catch {
    // localStorage full/unavailable — non-fatal; we just re-read next load.
  }
}

// ============================================================
// DICTATOR — each day one member is deterministically "elected" Dictator
// (no backend: every device computes the same answer from the UTC date +
// participant list). They may demote one teammate to "Plebeian" for the day
// and set a quote of the day. State persists in the `decrees` collection,
// keyed by UTC date, and auto-expires when the date rolls over.
// ============================================================

// Canonical date for the election + decree doc id. UTC so members in different
// timezones (UTC+1 / UTC+8) always agree on who today's Dictator is.
function getUTCTodayStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// FNV-1a → 0..1 float, deterministic per string.
function fracHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) / 0xffffffff;
}

// Today's Dictator name, derived purely from the date + sorted participant
// names so all devices agree. Returns null if there are no participants.
function getDictatorForDay(dateStr, names) {
  const sorted = [...names].sort();
  if (!sorted.length) return null;
  const idx = Math.floor(fracHash(dateStr + "|" + sorted.join(",")) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// Current Dictator (today, UTC). An admin override on today's decree takes
// precedence over the deterministic pick; otherwise it's the random election.
function currentDictator() {
  const today = getUTCTodayStr();
  if (
    state.decree &&
    state.decree.date === today &&
    state.decree.overrideDictator
  )
    return state.decree.overrideDictator;
  return getDictatorForDay(
    today,
    state.participants.map((p) => p.name),
  );
}

// Today's Plebeian name, only if the decree is for the current UTC date.
function currentPleb() {
  return state.decree && state.decree.date === getUTCTodayStr()
    ? state.decree.pleb || null
    : null;
}

// Previous UTC calendar day for a YYYY-MM-DD string.
function utcPrevDay(dateStr) {
  const dt = new Date(dateStr + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// Everyone currently demoted to Plebeian. In a multi-day reign (the same
// Dictator elected several UTC days in a row) demotions are STRICTLY ADDITIVE:
// each earlier day's pleb (state.reignPlebs, filled by refreshReignPlebs) plus
// today's live pick build up together, and the whole set resets the instant the
// reign ends and a new Dictator takes the crown. Returns a Set of names.
function currentPlebs() {
  const set = new Set(state.reignPlebs || []);
  const today = currentPleb();
  if (today) set.add(today);
  return set;
}

// Recompute the plebs accumulated on EARLIER days of the current reign. Walk
// back from yesterday while the elected Dictator matches today's Dictator — the
// first mismatch is the reign boundary (this is what makes plebs auto-reset when
// the crown changes hands). The election is deterministic per date, so we only
// READ decree docs for the days actually inside the reign (usually 0–1), keeping
// this well within the Firestore free tier. Today's own pleb is read live via
// currentPleb(), so it's deliberately excluded here.
async function refreshReignPlebs() {
  if (!db || !state.participants.length) {
    state.reignPlebs = [];
    return;
  }
  const names = state.participants.map((p) => p.name);
  const dict = currentDictator();
  if (!dict) {
    state.reignPlebs = [];
    return;
  }
  const reignDates = [];
  let cursor = utcPrevDay(getUTCTodayStr());
  for (let i = 0; i < 60; i++) {
    if (getDictatorForDay(cursor, names) !== dict) break; // reign boundary
    reignDates.push(cursor);
    cursor = utcPrevDay(cursor);
  }
  const plebs = [];
  for (const date of reignDates) {
    try {
      const snap = await getDoc(doc(db, "decrees", date));
      const pleb = snap.exists() ? snap.data().pleb : null;
      if (pleb && !plebs.includes(pleb)) plebs.push(pleb);
    } catch {
      /* a single unreadable day shouldn't break the build-up */
    }
  }
  state.reignPlebs = plebs;
  if (state.currentUser) renderCurrentView();
}

// Crown badge for the day's Dictator, worn on their avatar. Returns "" for
// everyone else (the Plebeian is marked by their "Plebeian" rename, not a
// badge). Positioned by `.royal-badge` CSS against a relative avatar container.
function royalBadgeHTML(p) {
  if (!p || !p.name) return "";
  if (p.name === currentDictator())
    return `<span class="royal-badge crown" title="Today's Dictator">👑</span>`;
  return "";
}

// Live listener on today's decree doc. The doc id is the UTC date, so on day
// rollover we must tear down and re-subscribe to the new date's doc.
let _decreeUnsub = null;
let _decreeSubDate = null;

function subscribeDecree() {
  if (!db) return;
  const date = getUTCTodayStr();
  if (_decreeSubDate === date && _decreeUnsub) return; // already on the right doc
  if (_decreeUnsub) _decreeUnsub();
  _decreeSubDate = date;
  _decreeUnsub = onSnapshot(
    doc(db, "decrees", date),
    (snap) => {
      state.decree = snap.exists() ? { date, ...snap.data() } : { date };
      if (state.currentUser) {
        renderCurrentView();
        // Now that today's decree is loaded we can tell whether a pleb was
        // already declared (possibly on another device) before offering the
        // appointment popup.
        maybeShowDictatorPopup();
      }
    },
    (err) => console.warn("[Dictator] decree listener error:", err.message),
  );
}

// Live listener on settings/app — keeps the sticky Dictator quote (and the
// challenge dates) fresh. Unlike the decree, this doc is NOT keyed by date, so
// the quote persists across days until a Dictator overwrites it.
let _settingsUnsub = null;
function subscribeSettings() {
  if (!db || _settingsUnsub) return;
  _settingsUnsub = onSnapshot(
    doc(db, "settings", "app"),
    (snap) => {
      const data = snap.exists() ? snap.data() : {};
      if (data.challengeEndDate) CONFIG.CHALLENGE_END_DATE = data.challengeEndDate;
      if (data.challengeStartDate)
        CONFIG.CHALLENGE_START_DATE = data.challengeStartDate;
      state.dictatorQuote =
        data.dictatorQuote && data.dictatorQuote.text
          ? { text: data.dictatorQuote.text, by: data.dictatorQuote.by || null }
          : null;
      if (state.currentUser) renderCurrentView();
    },
    (err) => console.warn("[Dictator] settings listener error:", err.message),
  );
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
  let streak = participant.currentStreak ?? 0;

  // Use the participant's own timezone to determine their "today", so viewers
  // in a different timezone don't see a stale streak during the gap window
  // between the viewer's midnight and the participant's midnight.
  const participantToday =
    participant.timezoneOffset != null
      ? getTodayStrForOffset(participant.timezoneOffset)
      : state.todayStr;

  // Walk any days between finesThrough+1 and the participant's today that
  // haven't been checkpointed yet (e.g. participant is behind viewer's TZ).
  const through = participant.finesThrough || participant.joinedDate;
  if (through && through < participantToday) {
    const d = new Date(through + "T00:00:00");
    d.setDate(d.getDate() + 1);
    const participantTodayDate = new Date(participantToday + "T00:00:00");
    while (d < participantTodayDate) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (isWorkoutComplete(name, dateStr)) {
        streak++;
      } else if (isOffDay(name, dateStr)) {
        // sick or rest day: no increment, no reset
      } else {
        streak = 0;
      }
      d.setDate(d.getDate() + 1);
    }
  }

  if (isWorkoutComplete(name, participantToday)) return streak + 1;
  if (isOffDay(name, participantToday)) return streak; // paused: no increment, no reset
  return streak;
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

// Display name shown to users. `name` stays the immutable identity key (Firestore
// doc id + `person` field on completions/tokens); `displayName` is optional and
// only affects rendering. Falls back to `name` when unset.
function getDisplayName(p) {
  if (!p) return "";
  // Dictator feature: every current Plebeian is renamed everywhere (this is the
  // one central name site, so cards/leaderboard/history/etc. all pick it up).
  // In a multi-day reign this can be several people at once (see currentPlebs).
  // The Dictator's name is left untouched — they get the 👑 avatar badge instead.
  if (p.name && currentPlebs().has(p.name)) return "Plebeian";
  return typeof p.displayName === "string" && p.displayName.trim()
    ? p.displayName.trim()
    : p.name ?? "";
}

function avatarHTML(participant, className) {
  const color = getParticipantColor(participant);
  const badge = royalBadgeHTML(participant);
  // With a badge we let the avatar overflow so the badge can sit on its edge;
  // the image gets its own border-radius so it stays circular regardless.
  if (participant.avatar) {
    const overflow = badge ? "overflow:visible;position:relative;" : "overflow:hidden;";
    return `<div class="${className}" style="background:${color};padding:0;${overflow}"><img src="${participant.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="${getDisplayName(participant)}">${badge}</div>`;
  }
  const pos = badge ? "overflow:visible;position:relative;" : "";
  return `<div class="${className}" style="background:${color};${pos}">${getInitials(getDisplayName(participant))}${badge}</div>`;
}

function progressRingHTML(pct, color, offDay, participant) {
  const size = 64;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, pct));
  const offset = c * (1 - clamped);
  const initials = getInitials(getDisplayName(participant));
  const innerSize = size - stroke * 2 - 4;
  const inner = participant.avatar
    ? `<image href="${participant.avatar}" x="${(size - innerSize) / 2}" y="${(size - innerSize) / 2}" width="${innerSize}" height="${innerSize}" clip-path="circle(${innerSize / 2}px at ${innerSize / 2}px ${innerSize / 2}px)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${size / 2}" cy="${size / 2}" r="${innerSize / 2}" fill="${color}"/><text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" fill="white" font-size="11" font-weight="800">${initials}</text>`;
  return `
    <svg class="gsm-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="${stroke}"/>
      <circle class="gsm-ring-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
        stroke="${offDay ? "var(--warning)" : color}" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
        transform="rotate(-90 ${size / 2} ${size / 2})"/>
      ${inner}
    </svg>
  `;
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

function renderColorPicker() {
  const wrap = document.getElementById("color-picker-swatches");
  if (!wrap || !state.currentUser) return;
  const currentIdx = state.currentUser.colorIndex;
  // Build set of color indexes already taken by other participants
  const taken = new Set(
    state.participants
      .filter((p) => p.name !== state.currentUser.name)
      .map((p) => p.colorIndex),
  );
  wrap.innerHTML = COLORS.map((color, i) => {
    const isCurrent = i === currentIdx;
    const isTaken = taken.has(i) && !isCurrent;
    return `<button type="button" class="color-swatch${isCurrent ? " selected" : ""}${isTaken ? " taken" : ""}" data-color-index="${i}" style="--swatch-color:${color};" ${isTaken ? "disabled" : ""} aria-label="Color ${i + 1}${isTaken ? " (taken)" : ""}"></button>`;
  }).join("");
  wrap.querySelectorAll(".color-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.colorIndex, 10);
      if (idx === state.currentUser.colorIndex) return;
      saveColorChoice(idx);
    });
  });
}

async function saveColorChoice(newIdx) {
  const prev = state.currentUser.colorIndex;
  state.currentUser.colorIndex = newIdx;
  const p = state.participants.find((p) => p.name === state.currentUser.name);
  if (p) p.colorIndex = newIdx;
  renderColorPicker();
  renderHeader();
  renderCurrentView();
  try {
    await updateDoc(doc(db, "participants", state.currentUser.name), {
      colorIndex: newIdx,
    });
    showToast("Color updated", "success");
  } catch (err) {
    state.currentUser.colorIndex = prev;
    if (p) p.colorIndex = prev;
    renderColorPicker();
    renderHeader();
    renderCurrentView();
    showToast("Failed to save color: " + err.message, "error");
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
    if (isOffDay(name, date)) continue;
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
  const participantToday =
    participant.timezoneOffset != null
      ? getTodayStrForOffset(participant.timezoneOffset)
      : state.todayStr;
  const recentDates = [];
  const d = new Date(since + "T00:00:00");
  d.setDate(d.getDate() + 1); // start the day after `since`
  const end = new Date(participantToday + "T00:00:00");
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

function isRestDay(name, date) {
  const p = state.participants.find((p) => p.name === name);
  return Array.isArray(p?.restDays) && p.restDays.includes(date);
}

// "Off day" = sick OR rest. Both exempt from fines and streak changes.
function isOffDay(name, date) {
  return isSickDay(name, date) || isRestDay(name, date);
}

// Monday-anchored week. dateStr = "YYYY-MM-DD". Returns the Monday's date string.
function getWeekStartLocal(dateStr) {
  const d = new Date(dateStr + "T12:00:00"); // noon avoids DST edges
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function restDaysUsedThisWeek(name, referenceDate) {
  const p = state.participants.find((p) => p.name === name);
  if (!Array.isArray(p?.restDays)) return 0;
  const weekStart = getWeekStartLocal(referenceDate);
  const weekEnd = new Date(weekStart + "T12:00:00");
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);
  return p.restDays.filter((d) => d >= weekStart && d <= weekEndStr).length;
}

function restDaysRemainingThisWeek(name, referenceDate) {
  return Math.max(0, 1 - restDaysUsedThisWeek(name, referenceDate));
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

async function toggleRestDay(name, date) {
  const participant = state.participants.find((p) => p.name === name);
  if (!participant) return;
  const prev = Array.isArray(participant.restDays)
    ? [...participant.restDays]
    : [];
  const alreadyRest = prev.includes(date);

  // Enforce 1 per calendar week (Mon–Sun) — but always allow toggling off.
  if (!alreadyRest && restDaysRemainingThisWeek(name, date) <= 0) {
    showToast("Already used your rest day this week", "error");
    return;
  }

  const next = alreadyRest ? prev.filter((d) => d !== date) : [...prev, date];

  participant.restDays = next;
  if (state.currentUser?.name === name) state.currentUser.restDays = next;

  try {
    await updateDoc(doc(db, "participants", name), { restDays: next });
    rebuildCache();
    renderCurrentView();
    showToast(
      alreadyRest
        ? "Rest day removed"
        : "Rest day marked 🏖️ — no fines, streak held",
      "info",
    );
  } catch (err) {
    participant.restDays = prev;
    if (state.currentUser?.name === name) state.currentUser.restDays = prev;
    showToast("Failed to update: " + err.message, "error");
  }
}

function parseTimeLabelToMinutes(label) {
  const m = label?.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (m[3] === "PM" && h !== 12) h += 12;
  if (m[3] === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

function formatMinutesToTimeLabel(mins) {
  if (mins == null) return "—";
  let h = Math.floor(mins / 60);
  const min = String(mins % 60).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

function getWorkoutCompletionTime(personName, date) {
  if (!isWorkoutComplete(personName, date)) return null;
  const completions = state.completions.filter(
    (c) =>
      c.date === date &&
      c.person === personName &&
      c.completed &&
      c.completedAt,
  );
  if (!completions.length) return null;
  const timestamps = completions
    .map((c) => new Date(c.completedAt).getTime())
    .filter((t) => !isNaN(t));
  if (!timestamps.length) return null;
  const latestMs = Math.max(...timestamps);
  const latestCompletion = completions.find(
    (c) => new Date(c.completedAt).getTime() === latestMs,
  );
  // completedAt is stored as local ISO string (e.g. "2026-04-02T14:30:00-07:00")
  // Extract the time component directly — it's already the person's local time
  const m = latestCompletion.completedAt.match(/T(\d{2}):(\d{2})/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2];
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${min} ${ampm}`;
  }
  return new Date(latestMs).toLocaleTimeString("en-US", {
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

function getTodayStrForOffset(offsetMinutes) {
  const now = new Date();
  const local = new Date(now.getTime() - offsetMinutes * 60000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

async function advanceFineCheckpoints() {
  if (!db) return;
  // Only advance the logged-in participant's own aggregates. Other devices may
  // have offline-queued completions that haven't reached Firestore yet; if a
  // different user's device runs the advance against that stale view it will
  // wrongly fine them, and the bad state is sticky once finesThrough moves past
  // the day. Each participant is the source of truth for their own completions.
  const me = state.currentUser
    ? state.participants.find((p) => p.name === state.currentUser.name)
    : null;
  if (!me) return;
  for (const p of [me]) {
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
    let earliestMins = p.earliestWorkoutMinutes ?? null;
    let latestMins = p.latestWorkoutMinutes ?? null;

    for (const date of newDates) {
      if (isWorkoutComplete(p.name, date)) {
        streak++;
        const tLabel = getWorkoutCompletionTime(p.name, date);
        const tMins = parseTimeLabelToMinutes(tLabel);
        if (tMins != null) {
          if (earliestMins == null || tMins < earliestMins)
            earliestMins = tMins;
          if (latestMins == null || tMins > latestMins) latestMins = tMins;
        }
      } else if (isOffDay(p.name, date)) {
        // sick or rest day: no fine, streak pauses (no increment, no reset)
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
      earliestWorkoutMinutes: earliestMins,
      latestWorkoutMinutes: latestMins,
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
      let earliestMins = null;
      let latestMins = null;

      for (const date of allDates) {
        if (isWorkoutComplete(p.name, date)) {
          currentStreak++;
          bestStreak = Math.max(bestStreak, currentStreak);
          const tMins = parseTimeLabelToMinutes(
            getWorkoutCompletionTime(p.name, date),
          );
          if (tMins != null) {
            if (earliestMins == null || tMins < earliestMins)
              earliestMins = tMins;
            if (latestMins == null || tMins > latestMins) latestMins = tMins;
          }
        } else if (isOffDay(p.name, date)) {
          // sick or rest day: streak pauses (no increment, no reset)
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
        earliestWorkoutMinutes: earliestMins,
        latestWorkoutMinutes: latestMins,
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

    const ninetyDaysAgo = dateStrDaysAgo(90);
    const volatileFrom = dateStrDaysAgo(VOLATILE_DAYS); // start of the live window

    // Split-window: serve stable older days from localStorage, subscribe live
    // only to the volatile recent days. `liveFrom` normally = volatileFrom, but
    // backs up to fill any gap since the cache was last written (e.g. app idle
    // for weeks) — never earlier than the 90-day window.
    const cache = loadCompletionsCache();
    let liveFrom = ninetyDaysAgo;
    let coldDocs = [];
    if (cache) {
      liveFrom = volatileFrom;
      const afterCached = addDaysToDateStr(cache.cachedThrough, 1);
      if (afterCached < liveFrom) liveFrom = afterCached; // fill gap
      if (liveFrom < ninetyDaysAgo) liveFrom = ninetyDaysAgo;
      coldDocs = cache.docs.filter(
        (c) => c.date >= ninetyDaysAgo && c.date < liveFrom,
      );
    }

    onSnapshot(
      query(collection(db, "completions"), where("date", ">=", liveFrom)),
      (snap) => {
        const liveDocs = snap.docs.map((d) => d.data());
        // Cold (cached) and live docs are disjoint by date, so a plain concat
        // is dedup-safe.
        state.completions = coldDocs.concat(liveDocs);
        // Re-apply any in-flight optimistic writes so a snapshot for one
        // exercise doesn't visually revert another exercise mid-save.
        applyPendingOptimistic();

        // Promote now-stable days (older than the volatile window) into the
        // cache so the next reload reads even fewer docs, and prune anything
        // past the 90-day window.
        const cacheThrough = addDaysToDateStr(volatileFrom, -1);
        const stable = state.completions.filter(
          (c) => c.date >= ninetyDaysAgo && c.date <= cacheThrough,
        );
        saveCompletionsCache(cacheThrough, stable);

        gotCompletions = true;
        if (gotParticipants) onBothLoaded();
      },
      (err) => {
        if (!initialResolved) reject(err);
        else
          console.warn("[Firestore] completions listener error:", err.message);
      },
    );

    subscribeDecree(); // Dictator feature: live today's-decree listener
    subscribeSettings(); // Dictator feature: live sticky quote (+ challenge dates)
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
  if (idx >= 0) {
    state.completions[idx].completed = completed;
    state.completions[idx].completedAt = item.completedAt;
  } else {
    state.completions.push(item);
  }

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
// NUDGES — poke a teammate (5/day). Cheer the done, watch the not-done.
// ============================================================

const NUDGE_DAILY_MAX = 5;

function nudgesUsedToday() {
  try {
    const raw = JSON.parse(localStorage.getItem("np_nudges") || "{}");
    return raw.date === state.todayStr ? raw.count || 0 : 0;
  } catch {
    return 0;
  }
}

function nudgesRemainingToday() {
  return Math.max(0, NUDGE_DAILY_MAX - nudgesUsedToday());
}

function recordNudge() {
  try {
    localStorage.setItem(
      "np_nudges",
      JSON.stringify({ date: state.todayStr, count: nudgesUsedToday() + 1 }),
    );
  } catch {}
}

// Tokens grouped by person, cached briefly so rapid spamming doesn't re-read
// the whole collection on every tap.
let _nudgeTokenCache = { ts: 0, byPerson: null };

async function getNudgeTokensByPerson() {
  if (_nudgeTokenCache.byPerson && Date.now() - _nudgeTokenCache.ts < 60000)
    return _nudgeTokenCache.byPerson;
  const snap = await getDocs(collection(db, "tokens"));
  const byPerson = {};
  snap.docs
    .map((d) => d.data())
    .forEach((t) => {
      (byPerson[t.person] ||= []).push(t.token);
    });
  _nudgeTokenCache = { ts: Date.now(), byPerson };
  return byPerson;
}

// Push line = "{me} nudged you: {body}" / "{me} gave kudos: {body}". Only the
// body is user-editable (in the profile modal); the lead is fixed. Device-local
// — used only on the sender's device, so it never needs to sync.
const NUDGE_DEFAULT_BODY = "finish today's workout — I'm watching!";
const KUDOS_DEFAULT_BODY = "great work finishing today!";

function getNudgeBody(isDone) {
  try {
    const v = (
      localStorage.getItem(isDone ? "np_kudos_msg" : "np_nudge_msg") || ""
    ).trim();
    if (v) return v;
  } catch {}
  return isDone ? KUDOS_DEFAULT_BODY : NUDGE_DEFAULT_BODY;
}

function setNudgeBody(isDone, text) {
  try {
    const key = isDone ? "np_kudos_msg" : "np_nudge_msg";
    const t = (text || "").trim();
    if (t) localStorage.setItem(key, t);
    else localStorage.removeItem(key);
  } catch {}
}

// Fire the actual push — background, never awaited by the tap handler, so
// you can spam as fast as you can tap up to your remaining count.
async function deliverNudge(targetName, isDone) {
  const me = state.currentUser?.name;
  if (!me) return;
  const lead = isDone ? `${me} gave kudos` : `${me} nudged you`;
  const message = `${lead}: ${getNudgeBody(isDone)}`;
  try {
    const byPerson = await getNudgeTokensByPerson();
    const tokens = byPerson[targetName] || [];
    if (!tokens.length) return;
    await fetch("/.netlify/functions/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, tokens }),
    });
  } catch (err) {
    console.warn("[Nudge] delivery failed:", err.message);
  }
}

// Tick one pip to spent in place (no full re-render, so rapid taps stay smooth)
function spendNudgePipInPlace(summary) {
  const remaining = nudgesRemainingToday();
  const pip = summary.querySelectorAll(".nudge-pip")[remaining];
  if (pip && !pip.classList.contains("spent")) {
    pip.classList.remove("just-spent");
    void pip.offsetWidth; // restart the pop animation on rapid taps
    pip.classList.add("spent", "just-spent");
  }
  if (remaining <= 0) {
    summary.querySelector(".nudge-meter")?.classList.add("empty");
    const label = summary.querySelector(".nudge-meter-label");
    if (label) label.textContent = "spent";
  }
}

// One tap = one optimistic spend. Synchronous so the daily cap is enforced
// even under rapid fire; the network push goes out in the background.
function spendNudge(targetName, isDone, btn, summary) {
  const me = state.currentUser?.name;
  if (!me || targetName === me) return;
  if (nudgesRemainingToday() <= 0) return;
  recordNudge();
  btn.blur(); // drop focus so no glow lingers after the tap
  spawnNudgeBurst(btn, isDone);
  spendNudgePipInPlace(summary);
  if (nudgesRemainingToday() <= 0)
    summary.querySelectorAll(".gsm-nudge").forEach((b) => (b.disabled = true));
  deliverNudge(targetName, isDone);
}

// Visual send moment: the emoji (👀 / ❤️) floats up off the button over an
// expanding accent ring. Fired optimistically on tap — purely cosmetic.
function spawnNudgeBurst(btn, isDone) {
  const faceEl = btn.querySelector(".gsm-nudge-face") || btn;
  const r = faceEl.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const accent = isDone ? "0, 217, 163" : "255, 159, 67";
  const emoji = isDone ? "❤️" : "👀";

  const ring = document.createElement("div");
  ring.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;width:18px;height:18px;
    margin:-9px 0 0 -9px;border-radius:50%;pointer-events:none;z-index:9998;
    border:2px solid rgba(${accent},0.85);`;
  document.body.appendChild(ring);
  ring.animate(
    [
      { transform: "scale(0.4)", opacity: 0.9 },
      { transform: "scale(3)", opacity: 0 },
    ],
    {
      duration: 460,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "forwards",
    },
  ).onfinish = () => ring.remove();

  const fly = document.createElement("div");
  fly.textContent = emoji;
  fly.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;pointer-events:none;
    z-index:9999;font-size:19px;line-height:1;will-change:transform,opacity;`;
  document.body.appendChild(fly);
  const dx = (Math.random() - 0.5) * 28;
  fly.animate(
    [
      { transform: "translate(-50%,-50%) scale(0.6)", opacity: 0 },
      {
        transform: "translate(-50%,-50%) scale(1.35)",
        opacity: 1,
        offset: 0.2,
      },
      {
        transform: `translate(calc(-50% + ${dx}px), calc(-50% - 48px)) scale(0.7)`,
        opacity: 0,
      },
    ],
    {
      duration: 720,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "forwards",
    },
  ).onfinish = () => fly.remove();
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
      <span>${getDisplayName(p)}</span>
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
    `${getDisplayName(participant)}'s PIN`;
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
// REACTIONS
// ============================================================

// ============================================================
// RENDER: TODAY VIEW
// ============================================================

function renderTodayView() {
  const container = document.getElementById("today-cards-container");
  container.innerHTML = "";

  const d = new Date();
  renderDictatorQuote(container); // Dictator feature: quote of the day banner (prepended)
  const weekdayEl = document.getElementById("today-weekday");
  const monthdayEl = document.getElementById("today-monthday");
  if (weekdayEl)
    weekdayEl.textContent = d.toLocaleDateString("en-US", { weekday: "long" });
  if (monthdayEl)
    monthdayEl.textContent = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  updateDeadlineCountdown();

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
    const restToday = isRestDay(participant.name, state.todayStr);
    const offToday = sickToday || restToday;
    const restRemaining = restDaysRemainingThisWeek(
      participant.name,
      state.todayStr,
    );
    const color = getParticipantColor(participant);
    const initials = getInitials(getDisplayName(participant));
    const streak =
      state.cache[participant.name]?.streak ?? calcStreak(participant.name);

    const card = document.createElement("div");
    card.className = `workout-card${isMe ? " is-me" : ""}${allDone ? " completed-all" : ""}${offToday && !allDone ? (restToday ? " rest-today" : " sick-today") : ""}`;
    card.id = `card-${participant.name.replace(/\s+/g, "-")}`;
    const cardAvatarHTML = avatarHTML(participant, "card-avatar");

    const exercisesHTML = CONFIG.EXERCISES.map((ex) => {
      const done = completedToday.includes(ex.id);
      let countNow = 0;
      if (isMe) {
        countNow = getCount(participant.name, ex.id, state.todayStr);
        if (done && countNow < ex.targetCount) {
          setCountLocal(
            participant.name,
            ex.id,
            state.todayStr,
            ex.targetCount,
          );
          countNow = ex.targetCount;
        } else if (!done && countNow >= ex.targetCount) {
          setCountLocal(participant.name, ex.id, state.todayStr, 0);
          countNow = 0;
        }
      }
      const pct = Math.min(100, Math.round((countNow / ex.targetCount) * 100));
      const counterDisabled = !isMe || offToday ? "disabled" : "";
      const inc = getIncrement(ex.id);
      const ctaHTML = isMe
        ? `
        <div class="exercise-cta-row">
          <button class="counter-btn counter-dec" data-person="${participant.name}" data-exercise="${ex.id}" data-direction="dec" ${counterDisabled} aria-label="Remove ${inc}">−</button>
          <button class="counter-btn counter-inc" data-person="${participant.name}" data-exercise="${ex.id}" data-direction="inc" ${counterDisabled}>
            <span class="cta-fill" aria-hidden="true"></span>
            <span class="cta-label">+${inc}</span>
          </button>
          <button class="counter-settings-btn" data-exercise="${ex.id}" ${counterDisabled} title="Set ${ex.unit} per tap" aria-label="Set ${ex.unit} per tap">set ${ex.unit}</button>
        </div>`
        : "";
      const metaCounter = isMe
        ? `<span class="counter-display" data-person="${participant.name}" data-exercise="${ex.id}" data-target="${ex.targetCount}" data-unit="${ex.unit}" style="cursor:pointer" title="Tap to set exact count (${ex.unit})">${countNow} / ${ex.targetCount}</span>`
        : "";
      const undoHTML = isMe
        ? `<button class="exercise-undo" data-person="${participant.name}" data-exercise="${ex.id}" title="Undo — mark not done" aria-label="Undo">↺</button>`
        : "";
      const displayName = isMe ? getExerciseName(ex.id) : ex.name;
      const noteText = isMe ? getExerciseNote(ex.id) : "";
      const emojiHTML = isMe
        ? `<span class="exercise-emoji exercise-emoji-edit" data-exercise="${ex.id}" title="Rename / add a note (only on your device)" role="button" tabindex="0">${ex.emoji}</span>`
        : `<span class="exercise-emoji">${ex.emoji}</span>`;
      return `
        <div class="exercise-item${done ? " exercise-done" : ""}" style="--pct:${pct}%">
          <div class="exercise-meta">
            ${emojiHTML}
            <span class="exercise-label">
              <span class="exercise-name">${displayName}</span>
              ${noteText ? `<span class="exercise-note">${noteText}</span>` : ""}
            </span>
            ${metaCounter}
            ${undoHTML}
          </div>
          ${ctaHTML}
        </div>
      `;
    }).join("");

    const completionTime = allDone
      ? getWorkoutCompletionTime(participant.name, state.todayStr)
      : null;
    const substatusText =
      allDone && completionTime
        ? `Done at ${completionTime}`
        : allDone
          ? "All done"
          : "";

    const bannerHTML = offToday
      ? `
        <div class="off-day-banner ${restToday ? "rest" : "sick"}">
          <span class="banner-icon">${restToday ? "🏖️" : "🤒"}</span>
          <span class="banner-text">${restToday ? "Rest day" : "Sick day"} · no fines today</span>
          ${isMe ? `<button class="banner-undo" data-person="${participant.name}" data-type="${restToday ? "rest" : "sick"}" aria-label="Undo off-day">✕</button>` : ""}
        </div>`
      : "";

    const streakHTML =
      streak > 0
        ? `
        <div class="card-streak" aria-label="${streak}-day streak">
          <span class="card-streak-flame" aria-hidden="true">🔥</span>
          <span class="card-streak-num">${streak}</span>
          <span class="card-streak-label">${streak === 1 ? "day" : "day"} streak</span>
        </div>`
        : "";

    const menuShown = isMe && !offToday && !allDone;
    const restDisabled = restRemaining === 0;
    const menuHTML = menuShown
      ? `
        <button class="card-menu-btn" aria-label="Day options" aria-haspopup="true" aria-expanded="false">🥱</button>
        <div class="card-menu" role="menu" hidden>
          <button class="card-menu-item sick-day-btn" data-person="${participant.name}" role="menuitem">
            <span class="menu-icon">🤒</span>
            <span class="menu-label">Mark sick day</span>
          </button>
          <button class="card-menu-item rest-day-btn" data-person="${participant.name}" role="menuitem"${restDisabled ? " disabled" : ""}>
            <span class="menu-icon">🏖️</span>
            <span class="menu-label">Take rest day</span>
            <span class="menu-meta">${restRemaining} left this week</span>
          </button>
        </div>`
      : "";

    card.innerHTML = `
      <div class="card-header" style="--ring-color:${color}">
        ${bannerHTML}
        <div class="card-identity">
          ${cardAvatarHTML}
          <div class="card-info">
            <div class="card-name">${getDisplayName(participant)}</div>
            <div class="card-substatus">${substatusText}</div>
          </div>
        </div>
        ${streakHTML}
        ${menuHTML}
      </div>
      <div class="exercise-list">${exercisesHTML}</div>
      ${allDone ? '<div class="completion-banner">🎉 Workout Complete!</div>' : ""}
    `;

    if (isMe) {
      card.querySelectorAll(".counter-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          if (btn.dataset.editing) return;
          const { person, exercise, direction } = e.currentTarget.dataset;
          const inc = getIncrement(exercise);
          handleCountChange(person, exercise, direction === "inc" ? inc : -inc);
          if (direction === "inc") {
            spawnMatchaParticles(btn);
            playCounterInc();
          } else {
            playCounterDec();
          }
        });
      });
      card.querySelectorAll(".counter-settings-btn").forEach((settingsBtn) => {
        settingsBtn.addEventListener("click", () => {
          const exerciseId = settingsBtn.dataset.exercise;
          const incBtn = settingsBtn
            .closest(".exercise-item")
            ?.querySelector(`.counter-inc[data-exercise="${exerciseId}"]`);
          if (incBtn) editIncrement(incBtn);
        });
      });
      card.querySelectorAll(".counter-display").forEach((span) => {
        span.addEventListener("click", () => editCountInline(span));
      });
      card.querySelectorAll(".exercise-emoji-edit").forEach((emojiEl) => {
        const openEdit = () => {
          const labelEl = emojiEl
            .closest(".exercise-meta")
            ?.querySelector(".exercise-label");
          if (labelEl) editExerciseDetails(labelEl, emojiEl.dataset.exercise);
        };
        emojiEl.addEventListener("click", openEdit);
        emojiEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openEdit();
          }
        });
      });
      card.querySelectorAll(".exercise-undo").forEach((undoBtn) => {
        undoBtn.addEventListener("click", () => {
          const { person, exercise } = undoBtn.dataset;
          const current = getCount(person, exercise, state.todayStr);
          const inc = getIncrement(exercise);
          const ex = CONFIG.EXERCISES.find((e) => e.id === exercise);
          const delta = -Math.max(inc, current - (ex.targetCount - 1));
          handleCountChange(person, exercise, delta);
          playCounterDec();
        });
      });
      const sickBtn = card.querySelector(".sick-day-btn");
      if (sickBtn) {
        sickBtn.addEventListener("click", () =>
          toggleSickDay(participant.name, state.todayStr),
        );
      }
      const restBtn = card.querySelector(".rest-day-btn");
      if (restBtn) {
        restBtn.addEventListener("click", () =>
          toggleRestDay(participant.name, state.todayStr),
        );
      }
      const menuBtn = card.querySelector(".card-menu-btn");
      const menuPanel = card.querySelector(".card-menu");
      if (menuBtn && menuPanel) {
        const closeMenu = () => {
          menuPanel.hidden = true;
          menuBtn.setAttribute("aria-expanded", "false");
          document.removeEventListener("click", outside, true);
        };
        const outside = (e) => {
          if (!menuPanel.contains(e.target) && e.target !== menuBtn)
            closeMenu();
        };
        menuBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const open = menuPanel.hidden;
          if (open) {
            menuPanel.hidden = false;
            menuBtn.setAttribute("aria-expanded", "true");
            setTimeout(
              () => document.addEventListener("click", outside, true),
              0,
            );
          } else {
            closeMenu();
          }
        });
        menuPanel
          .querySelectorAll(".card-menu-item")
          .forEach((item) => item.addEventListener("click", closeMenu));
      }
      const bannerUndo = card.querySelector(".banner-undo");
      if (bannerUndo) {
        bannerUndo.addEventListener("click", () => {
          const { person, type } = bannerUndo.dataset;
          if (type === "rest") toggleRestDay(person, state.todayStr);
          else toggleSickDay(person, state.todayStr);
        });
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
    const nudgesLeft = nudgesRemainingToday();

    const tiles = others
      .map((p) => {
        const pToday = state.todayStr;
        const color = getParticipantColor(p);
        const done = getCompletedExercisesForDay(p.name, pToday);
        const isOtherSick = isSickDay(p.name, pToday);
        const isOtherRest = isRestDay(p.name, pToday);
        const isOtherOff = isOtherSick || isOtherRest;
        const isOtherDone = isWorkoutComplete(p.name, pToday);
        const total = CONFIG.EXERCISES.length;
        const pct = isOtherOff && !isOtherDone ? 0 : done.length / total;
        const completionTime = getWorkoutCompletionTime(p.name, pToday);
        const dots = CONFIG.EXERCISES.map((ex) => {
          const isDone = done.includes(ex.id);
          return `<span class="gsm-dot ${isDone ? "done" : "pending"}" title="${ex.name}">${ex.emoji}</span>`;
        }).join("");
        const statusLine = isOtherDone
          ? `<span class="gsm-status done">${completionTime ?? "✓"}</span>`
          : isOtherRest
            ? `<span class="gsm-status rest">🏖️ Rest Day</span>`
            : isOtherSick
              ? `<span class="gsm-status sick">🤒 Sick Day</span>`
              : `<span class="gsm-status">${done.length}/${total}</span>`;
        const offClass =
          isOtherOff && !isOtherDone ? (isOtherRest ? " rest" : " sick") : "";
        const nudgeBtn = isOtherDone
          ? `<button class="gsm-nudge cheer" data-nudge="${p.name}" data-done="1"${nudgesLeft ? "" : " disabled"} title="Send kudos to ${getDisplayName(p)}"><span class="gsm-nudge-face">❤️</span><span class="gsm-nudge-word">kudos</span></button>`
          : `<button class="gsm-nudge" data-nudge="${p.name}" data-done="0"${nudgesLeft ? "" : " disabled"} title="Nudge ${getDisplayName(p)}"><span class="gsm-nudge-face">👀</span><span class="gsm-nudge-word">nudge</span></button>`;
        return `
        <div class="gsm-tile${isOtherDone ? " done" : ""}${offClass}" style="--tile-color:${color}">
          <div class="gsm-ring-wrap">${progressRingHTML(pct, color, isOtherOff && !isOtherDone, p)}${royalBadgeHTML(p)}</div>
          <div class="gsm-tile-name">${getDisplayName(p)}</div>
          ${statusLine}
          <div class="gsm-dots">${dots}</div>
          ${nudgeBtn}
        </div>
      `;
      })
      .join("");

    const allOthersDone = others.every((p) =>
      isWorkoutComplete(p.name, state.todayStr),
    );
    if (allOthersDone) summary.classList.add("all-done");
    const pips = Array.from(
      { length: NUDGE_DAILY_MAX },
      (_, i) =>
        `<span class="nudge-pip${i < nudgesLeft ? "" : " spent"}" aria-hidden="true"></span>`,
    ).join("");
    const meterLabel = nudgesLeft ? "left" : "spent";
    const nudgeMeter = `<span class="nudge-meter${nudgesLeft ? "" : " empty"}" role="img" aria-label="${nudgesLeft} of ${NUDGE_DAILY_MAX} nudges left today"><span class="nudge-pips">${pips}</span><span class="nudge-meter-label">${meterLabel}</span></span>`;
    summary.innerHTML = `<div class="gsm-label"><span class="gsm-label-text">Group Today</span>${nudgeMeter}</div><div class="gsm-grid">${tiles}</div>`;
    summary.querySelectorAll(".gsm-nudge").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        spendNudge(btn.dataset.nudge, btn.dataset.done === "1", btn, summary);
      });
    });
    container.appendChild(summary);
  }

  // Workout times chart
  container.insertAdjacentHTML("beforeend", renderWorkoutTimesChart());
  const attachRotate = () => {
    const btn = container.querySelector(".workout-times-chart-rotate");
    if (!btn) return;
    btn.addEventListener("click", () => {
      state.chartRotated = !state.chartRotated;
      try {
        localStorage.setItem(
          "np_chart_rotated",
          state.chartRotated ? "1" : "0",
        );
      } catch {}
      const wrap = container.querySelector(".workout-times-chart");
      if (wrap) wrap.outerHTML = renderWorkoutTimesChart();
      attachRotate();
    });
  };
  attachRotate();
}

// ============================================================
// REP COUNTER
// ============================================================

function getCount(personName, exerciseId, dateStr) {
  try {
    return (
      parseInt(
        localStorage.getItem(
          `np_count_${personName}_${exerciseId}_${dateStr}`,
        ) || "0",
      ) || 0
    );
  } catch {
    return 0;
  }
}

function setCountLocal(personName, exerciseId, dateStr, count) {
  try {
    if (count > 0)
      localStorage.setItem(
        `np_count_${personName}_${exerciseId}_${dateStr}`,
        String(count),
      );
    else
      localStorage.removeItem(
        `np_count_${personName}_${exerciseId}_${dateStr}`,
      );
  } catch {}
}

function getIncrement(exerciseId) {
  try {
    const stored = JSON.parse(localStorage.getItem("np_increments") || "{}");
    return (
      stored[exerciseId] ??
      CONFIG.EXERCISES.find((e) => e.id === exerciseId)?.increment ??
      1
    );
  } catch {
    return CONFIG.EXERCISES.find((e) => e.id === exerciseId)?.increment ?? 1;
  }
}

function setIncrement(exerciseId, value) {
  try {
    const stored = JSON.parse(localStorage.getItem("np_increments") || "{}");
    stored[exerciseId] = value;
    localStorage.setItem("np_increments", JSON.stringify(stored));
  } catch {}
}

// Device-local per-exercise customization (name override + personal note).
// Stored only in localStorage — never synced to Firestore, never seen by
// other participants. Keyed by exercise id: { squats: { name, note } }.
function getExerciseCustom(exerciseId) {
  try {
    const stored = JSON.parse(localStorage.getItem("np_ex_custom") || "{}");
    return stored[exerciseId] || {};
  } catch {
    return {};
  }
}

function getExerciseName(exerciseId) {
  const custom = getExerciseCustom(exerciseId).name;
  if (custom && custom.trim()) return custom.trim();
  return CONFIG.EXERCISES.find((e) => e.id === exerciseId)?.name ?? exerciseId;
}

function getExerciseNote(exerciseId) {
  const note = getExerciseCustom(exerciseId).note;
  return note && note.trim() ? note.trim() : "";
}

function setExerciseCustom(exerciseId, { name, note }) {
  try {
    const stored = JSON.parse(localStorage.getItem("np_ex_custom") || "{}");
    const defaultName = CONFIG.EXERCISES.find((e) => e.id === exerciseId)?.name;
    const entry = {};
    // Only persist a name override when it actually differs from the default.
    if (name && name.trim() && name.trim() !== defaultName)
      entry.name = name.trim();
    if (note && note.trim()) entry.note = note.trim();
    if (Object.keys(entry).length) stored[exerciseId] = entry;
    else delete stored[exerciseId];
    localStorage.setItem("np_ex_custom", JSON.stringify(stored));
  } catch {}
}

function updateDeadlineCountdown() {
  const el = document.getElementById("deadline-countdown");
  if (!el) return;
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msLeft = midnight - now;
  const minsLeft = Math.max(0, Math.round(msLeft / 60000));
  const hoursLeft = Math.floor(minsLeft / 60);
  const restMins = minsLeft % 60;

  let text;
  let tier;
  if (minsLeft <= 0) {
    text = "⏰ Resetting…";
    tier = "critical";
  } else if (minsLeft < 60) {
    text = `🚨 ${minsLeft} min${minsLeft === 1 ? "" : "s"} left!`;
    tier = "critical";
  } else if (hoursLeft < 3) {
    text = `⏰ ${hoursLeft}h ${restMins}m left`;
    tier = "warning";
  } else {
    text = `⏰ ${hoursLeft}h left`;
    tier = "calm";
  }

  el.textContent = text;
  el.classList.remove(
    "countdown-calm",
    "countdown-warning",
    "countdown-critical",
  );
  el.classList.add(`countdown-${tier}`);
}

let _deadlineTimer = null;
function startDeadlineTicker() {
  if (_deadlineTimer) return;
  _deadlineTimer = setInterval(updateDeadlineCountdown, 60_000);
}

function formatIncLabel(inc, unit) {
  if (unit === "reps") return `+${inc} ${inc === 1 ? "rep" : "reps"}`;
  if (unit === "min") return `+${inc} ${inc === 1 ? "min" : "mins"}`;
  return `+${inc} ${unit}`;
}

function addLongPress(el, callback) {
  let timer = null;
  let fired = false;
  const start = () => {
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      callback();
    }, 500);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchmove", cancel);
  el.addEventListener("mousedown", start);
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
  el.addEventListener("click", (e) => {
    if (fired) {
      e.stopImmediatePropagation();
      fired = false;
    }
  });
}

function editIncrement(btn) {
  const exerciseId = btn.dataset.exercise;
  const ex = CONFIG.EXERCISES.find((e) => e.id === exerciseId);
  const currentInc = getIncrement(exerciseId);
  btn.dataset.editing = "1";

  const labelEl = btn.querySelector(".cta-label");
  const targetEl = labelEl ?? btn;
  const targetWidth = Math.max(48, targetEl.offsetWidth);
  const input = document.createElement("input");
  input.type = "number";
  input.min = 1;
  input.max = ex?.targetCount ?? 100;
  input.value = currentInc;
  input.className = "counter-edit-input";
  input.style.width = targetWidth + "px";
  if (labelEl) {
    labelEl.replaceChildren(input);
  } else {
    btn.style.padding = "0";
    btn.replaceChildren(input);
  }
  input.focus();
  input.select();

  const commit = () => {
    const val = Math.max(
      1,
      Math.min(ex?.targetCount ?? 100, parseInt(input.value) || 1),
    );
    setIncrement(exerciseId, val);
    delete btn.dataset.editing;
    if (labelEl) {
      labelEl.textContent = `+${val}`;
    } else {
      btn.style.padding = "";
      btn.textContent = `+${val}`;
    }
  };
  const cancel = () => {
    delete btn.dataset.editing;
    if (labelEl) {
      labelEl.textContent = `+${currentInc}`;
    } else {
      btn.style.padding = "";
      btn.textContent = `+${currentInc}`;
    }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      input.removeEventListener("blur", commit);
      cancel();
    }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
}

function editCountInline(span) {
  const { person, exercise, target, unit } = span.dataset;
  const ex = CONFIG.EXERCISES.find((e) => e.id === exercise);
  const currentCount = getCount(person, exercise, state.todayStr);
  const targetCount = Number(target);

  const input = document.createElement("input");
  input.type = "number";
  input.min = 0;
  input.max = targetCount;
  input.value = currentCount;
  input.className = "counter-edit-input";
  input.style.width = span.offsetWidth + "px";
  span.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const val = Math.max(0, Math.min(targetCount, parseInt(input.value) || 0));
    const delta = val - getCount(person, exercise, state.todayStr);
    const newSpan = document.createElement("span");
    newSpan.className = "counter-display";
    newSpan.dataset.person = person;
    newSpan.dataset.exercise = exercise;
    newSpan.dataset.target = target;
    newSpan.dataset.unit = unit;
    newSpan.style.cursor = "pointer";
    newSpan.title = `Tap to set exact count (${unit})`;
    newSpan.textContent = `${val} / ${targetCount}`;
    input.replaceWith(newSpan);
    newSpan.addEventListener("click", () => editCountInline(newSpan));
    if (delta !== 0) handleCountChange(person, exercise, delta);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      input.removeEventListener("blur", commit);
      const newSpan = document.createElement("span");
      newSpan.className = "counter-display";
      newSpan.dataset.person = person;
      newSpan.dataset.exercise = exercise;
      newSpan.dataset.target = target;
      newSpan.dataset.unit = unit;
      newSpan.style.cursor = "pointer";
      newSpan.title = `Tap to set exact count (${unit})`;
      newSpan.textContent = `${currentCount} / ${targetCount}`;
      input.replaceWith(newSpan);
      newSpan.addEventListener("click", () => editCountInline(newSpan));
    }
  });
}

function editExerciseDetails(labelEl, exerciseId) {
  const ex = CONFIG.EXERCISES.find((e) => e.id === exerciseId);
  const currentName = getExerciseName(exerciseId);
  const currentNote = getExerciseNote(exerciseId);

  const form = document.createElement("div");
  form.className = "exercise-edit-form";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "exercise-edit-input ex-edit-name";
  nameInput.value = currentName;
  nameInput.placeholder = ex?.name ?? "Exercise name";
  nameInput.maxLength = 40;

  const noteInput = document.createElement("input");
  noteInput.type = "text";
  noteInput.className = "exercise-edit-input ex-edit-note";
  noteInput.value = currentNote;
  noteInput.placeholder = "Add a note…";
  noteInput.maxLength = 80;

  form.append(nameInput, noteInput);
  labelEl.replaceChildren(form);
  nameInput.focus();
  nameInput.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    setExerciseCustom(exerciseId, {
      name: nameInput.value,
      note: noteInput.value,
    });
    renderTodayView();
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    renderTodayView();
  };

  // Commit once focus leaves the whole form (not when hopping between the
  // two inputs). Defer so document.activeElement reflects the new focus.
  const onBlur = () => {
    setTimeout(() => {
      if (!form.contains(document.activeElement)) commit();
    }, 0);
  };
  [nameInput, noteInput].forEach((inp) => {
    inp.addEventListener("blur", onBlur);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
  });
}

function spawnMatchaParticles(btn) {
  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const COLORS = [
    "#4a7c59",
    "#6db36e",
    "#8fbe5b",
    "#00d9a3",
    "#3d9970",
    "#a8d5a2",
    "#2d6a4f",
  ];
  for (let i = 0; i < 16; i++) {
    const el = document.createElement("div");
    const size = 2 + Math.random() * 4;
    const isSquare = Math.random() < 0.3;
    el.style.cssText = `position:fixed;pointer-events:none;z-index:9999;
      width:${size}px;height:${size}px;
      border-radius:${isSquare ? "1px" : "50%"};
      background:${COLORS[Math.floor(Math.random() * COLORS.length)]};
      left:${cx}px;top:${cy}px;`;
    document.body.appendChild(el);
    const angle = -Math.PI * 0.9 + Math.random() * Math.PI * 1.8; // fan upward
    const speed = 35 + Math.random() * 65;
    const dx = Math.cos(angle) * speed;
    const dy = Math.sin(angle) * speed - 10;
    const rot = (Math.random() - 0.5) * 360;
    el.animate(
      [
        {
          transform: `translate(-50%,-50%) rotate(0deg) scale(1)`,
          opacity: 0.9,
        },
        {
          transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 18}px)) rotate(${rot}deg) scale(0.2)`,
          opacity: 0,
        },
      ],
      {
        duration: 450 + Math.random() * 300,
        easing: "cubic-bezier(0.2, 0.8, 0.4, 1)",
        fill: "forwards",
      },
    ).onfinish = () => el.remove();
  }
}

const _countSaveTimers = new Map();
// Optimistic completions kept across snapshot replacements until the save lands.
// Key: `${date}_${person}_${exercise}` → completion record.
const _pendingOptimistic = new Map();

function _pendingKey(date, person, exercise) {
  return `${date}_${person}_${exercise}`;
}

function applyPendingOptimistic() {
  for (const item of _pendingOptimistic.values()) {
    const idx = state.completions.findIndex(
      (c) =>
        c.date === item.date &&
        c.person === item.person &&
        c.exercise === item.exercise,
    );
    if (idx >= 0)
      state.completions[idx] = { ...state.completions[idx], ...item };
    else state.completions.push(item);
  }
}

function handleCountChange(personName, exerciseId, delta) {
  const ex = CONFIG.EXERCISES.find((e) => e.id === exerciseId);
  if (!ex) return;

  const currentCount = getCount(personName, exerciseId, state.todayStr);
  const newCount = Math.max(0, Math.min(ex.targetCount, currentCount + delta));

  if (newCount === currentCount) {
    return;
  }

  // Optimistic in-memory update
  const idx = state.completions.findIndex(
    (c) =>
      c.date === state.todayStr &&
      c.person === personName &&
      c.exercise === exerciseId,
  );
  const nowCompleted = newCount >= ex.targetCount;
  setCountLocal(personName, exerciseId, state.todayStr, newCount);
  const optimisticItem = {
    date: state.todayStr,
    person: personName,
    exercise: exerciseId,
    completed: nowCompleted,
    completedAt: nowCompleted ? localISOString(new Date()) : null,
  };
  _pendingOptimistic.set(
    _pendingKey(state.todayStr, personName, exerciseId),
    optimisticItem,
  );
  if (idx >= 0) {
    state.completions[idx].completed = nowCompleted;
    if (nowCompleted)
      state.completions[idx].completedAt = localISOString(new Date());
    else if (!nowCompleted) state.completions[idx].completedAt = null;
  } else {
    state.completions.push({
      date: state.todayStr,
      person: personName,
      exercise: exerciseId,
      completed: nowCompleted,
      completedAt: nowCompleted ? localISOString(new Date()) : null,
    });
  }

  // Update counter display
  const cardEl = document.getElementById(
    `card-${personName.replace(/\s+/g, "-")}`,
  );
  if (!cardEl) return;
  const exItem = [...cardEl.querySelectorAll(".exercise-item")].find((el) =>
    el.querySelector(`[data-exercise="${exerciseId}"]`),
  );
  const counterDisplay = exItem?.querySelector(".counter-display");
  if (counterDisplay)
    counterDisplay.textContent = `${newCount} / ${ex.targetCount}`;
  if (exItem) {
    const pct = Math.min(100, Math.round((newCount / ex.targetCount) * 100));
    exItem.style.setProperty("--pct", `${pct}%`);
  }

  // Sync exercise-item done state
  const wasCompleted = exItem?.classList.contains("exercise-done");

  if (nowCompleted && !wasCompleted) {
    exItem?.classList.add("exercise-done");
    playExerciseTick();
    if (
      isWorkoutComplete(personName, state.todayStr) &&
      !cardEl.classList.contains("completed-all")
    ) {
      cardEl.classList.add("completed-all", "just-completed");
      const sub = cardEl.querySelector(".card-substatus");
      const t = getWorkoutCompletionTime(personName, state.todayStr);
      if (sub) sub.textContent = t ? `Done at ${t}` : "All done";
      const menuBtn = cardEl.querySelector(".card-menu-btn");
      const menuPanel = cardEl.querySelector(".card-menu");
      if (menuBtn) menuBtn.remove();
      if (menuPanel) menuPanel.remove();
      if (!cardEl.querySelector(".completion-banner")) {
        const banner = document.createElement("div");
        banner.className = "completion-banner";
        banner.textContent = "🎉 Workout Complete!";
        cardEl.appendChild(banner);
      }
      triggerConfetti(getParticipantColor(state.currentUser));
      setTimeout(() => cardEl.classList.remove("just-completed"), 600);
    }
  } else if (!nowCompleted && wasCompleted) {
    exItem?.classList.remove("exercise-done");
    cardEl.classList.remove("completed-all");
    const banner = cardEl.querySelector(".completion-banner");
    if (banner) banner.remove();
    const sub = cardEl.querySelector(".card-substatus");
    if (sub) sub.textContent = "";
  }

  // Debounced Firestore write
  const timerKey = `${personName}_${exerciseId}`;
  if (_countSaveTimers.has(timerKey))
    clearTimeout(_countSaveTimers.get(timerKey));
  _countSaveTimers.set(
    timerKey,
    setTimeout(async () => {
      _countSaveTimers.delete(timerKey);
      try {
        await saveCompletion(personName, exerciseId, nowCompleted);
        _pendingOptimistic.delete(
          _pendingKey(state.todayStr, personName, exerciseId),
        );
        if (nowCompleted) {
          const streak = calcStreak(personName);
          const streakEl = cardEl.querySelector(".card-streak");
          if (streak > 0) {
            const innerHTML = `
              <span class="card-streak-flame" aria-hidden="true">🔥</span>
              <span class="card-streak-num">${streak}</span>
              <span class="card-streak-label">day streak</span>`;
            if (!streakEl) {
              const el = document.createElement("div");
              el.className = "card-streak";
              el.setAttribute("aria-label", `${streak}-day streak`);
              el.innerHTML = innerHTML;
              const identity = cardEl.querySelector(".card-identity");
              identity?.insertAdjacentElement("afterend", el);
            } else {
              streakEl.setAttribute("aria-label", `${streak}-day streak`);
              streakEl.innerHTML = innerHTML;
            }
          }
        }
      } catch {
        showToast("Failed to save. Try again.", "error");
      }
    }, 800),
  );
}

// ============================================================
// RENDER: LEADERBOARD
// ============================================================

// Roll a dollar figure up/down to a new value. Skips the animation
// when the value is unchanged or the user prefers reduced motion.
function animateCount(el, value) {
  const prev = Number(el.dataset.value);
  el.dataset.value = value;
  const reduce = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  if (!Number.isFinite(prev) || prev === value || reduce) {
    el.textContent = `$${value}`;
    return;
  }
  const start = performance.now();
  const dur = 650;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    el.textContent = `$${Math.round(prev + (value - prev) * eased)}`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

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

  // Magazine-style header: dedicated pot card + day-of-challenge stamp
  const potAmount = document.getElementById("lb-pot-amount");
  if (potAmount) animateCount(potAmount, groupPot);
  const potCard = document.getElementById("lb-pot-card");
  if (potCard) potCard.classList.toggle("is-empty", groupPot === 0);
  const progress = document.getElementById("lb-progress");
  let dayOf = null;
  let totalDays = null;
  if (CONFIG.CHALLENGE_START_DATE) {
    const startDate = new Date(CONFIG.CHALLENGE_START_DATE + "T00:00:00");
    if (todayMidnight >= startDate) {
      dayOf = Math.floor((todayMidnight - startDate) / 86400000) + 1;
      totalDays = Math.max(1, Math.round((endDate - startDate) / 86400000) + 1);
    }
  }
  if (progress) {
    if (dayOf != null) {
      progress.hidden = false;
      const pct = Math.min(100, Math.max(0, (dayOf / totalDays) * 100));
      document.getElementById("lb-progress-fill").style.width = `${pct}%`;
      document.getElementById("lb-progress-now").textContent =
        `Day ${dayOf} · ${Math.round(pct)}%`;
      document.getElementById("lb-progress-total").textContent =
        `${totalDays - dayOf} days left`;
    } else {
      progress.hidden = true;
    }
  }

  const data = state.participants.map((p) => {
    const totalFines =
      state.cache[p.name]?.fines ?? calcFinesForPersonAllTime(p.name);
    const totalDays = allDates.filter((d) => d !== state.todayStr);
    const totalCompletions = totalDays.filter((d) =>
      isWorkoutComplete(p.name, d),
    ).length;
    const streak = state.cache[p.name]?.streak ?? calcStreak(p.name);
    // Find the latest day this person fully completed their workout, and
    // the local time-of-day they finished it. Used as a tiebreak so that
    // "equal 1st" is ordered by who finished their workout earliest in
    // their own local time. Partial/in-progress days are ignored — marking
    // 1/3 today shouldn't drop you below people who completed yesterday.
    const lastWorkout = (() => {
      const datesDone = [
        ...new Set(
          state.completions
            .filter((c) => c.person === p.name && c.completed)
            .map((c) => c.date),
        ),
      ]
        .filter((d) => isWorkoutComplete(p.name, d))
        .sort();
      if (!datesDone.length) return null;
      const lastDate = datesDone[datesDone.length - 1];
      const dayCompletions = state.completions.filter(
        (c) =>
          c.date === lastDate &&
          c.person === p.name &&
          c.completed &&
          c.completedAt,
      );
      if (!dayCompletions.length) return null;
      const latestMs = Math.max(
        ...dayCompletions
          .map((c) => new Date(c.completedAt).getTime())
          .filter((t) => !isNaN(t)),
      );
      const latest = dayCompletions.find(
        (c) => new Date(c.completedAt).getTime() === latestMs,
      );
      // Extract local hh:mm from the stored local ISO string (with offset)
      const m = latest?.completedAt.match(/T(\d{2}):(\d{2})/);
      const localMinutes = m
        ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
        : null;
      return { date: lastDate, localMinutes };
    })();

    return {
      participant: p,
      totalFines,
      totalCompletions,
      streak,
      lastWorkout,
    };
  });

  data.sort((a, b) => {
    if (a.totalFines !== b.totalFines) return a.totalFines - b.totalFines;
    if (a.streak !== b.streak) return b.streak - a.streak;
    // Tiebreak: more completed workout days wins. Off days (sick/rest)
    // preserve streak but don't count as a completed workout — so someone
    // who rested yesterday and worked out first today doesn't leapfrog
    // people who actually worked out both days.
    if (a.totalCompletions !== b.totalCompletions)
      return b.totalCompletions - a.totalCompletions;
    // Then: prefer person whose most recent completed workout is more
    // recent; within the same date, earlier local finish time wins.
    const aw = a.lastWorkout,
      bw = b.lastWorkout;
    if (!aw && !bw) return 0;
    if (!aw) return 1;
    if (!bw) return -1;
    if (aw.date !== bw.date) return aw.date < bw.date ? 1 : -1;
    if (aw.localMinutes == null && bw.localMinutes == null) return 0;
    if (aw.localMinutes == null) return 1;
    if (bw.localMinutes == null) return -1;
    return aw.localMinutes - bw.localMinutes;
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
        entry.totalFines === prev.totalFines &&
        entry.streak === prev.streak &&
        entry.totalCompletions === prev.totalCompletions;
      entry.rank = tied ? prev.rank : i + 1;
    }
  });

  // Build podium (top 3) + rest list
  const podiumEl = document.getElementById("lb-podium");
  podiumEl.innerHTML = "";
  const podiumEntries = data.filter((e) => e.rank <= 3);
  const restEntries = data.filter((e) => e.rank > 3);

  const streakHTML = (entry) =>
    entry.streak > 0
      ? `<span class="lb-streak"><span class="lb-streak-flame">🔥</span><span class="lb-streak-num">${entry.streak}</span></span>`
      : `<span class="lb-streak-none">no streak</span>`;

  // -------- PODIUM (visual blocks) --------
  // Lay out one stand per podium entry. Tier (height/color) follows rank.
  // Classic 2 | 1 | 3 order ONLY when we have exactly one of each rank;
  // otherwise (any tie) fall back to rank-ascending left→right.
  const byRank = (r) => podiumEntries.filter((e) => e.rank === r);
  const firsts = byRank(1);
  const seconds = byRank(2);
  const thirds = byRank(3);

  // If there's a single clear winner, center them and arrange others around.
  // Otherwise (tied 1sts) fall back to rank-ascending left→right.
  let ordered;
  if (firsts.length === 1) {
    const others = [...seconds, ...thirds]; // rank-ordered: 2s closer to gold
    const left = [];
    const right = [];
    others.forEach((entry, i) => {
      // Alternate: silver/bronze pairs build outward from the center
      if (i % 2 === 0)
        left.unshift(entry); // even index → outer-left
      else right.push(entry); // odd index → outer-right
    });
    ordered = [...left, firsts[0], ...right];
  } else {
    ordered = [...firsts, ...seconds, ...thirds];
  }

  const standHTML = (entry) => {
    const tier = entry.rank;
    const medal = tier === 1 ? "🥇" : tier === 2 ? "🥈" : "🥉";
    const fineDisplay = entry.totalFines === 0 ? "$0" : `$${entry.totalFines}`;
    const fineClass = entry.totalFines === 0 ? "zero" : "";
    return `
      <div class="lb-stand tier-${tier}">
        <div class="lb-stand-stack">
          ${avatarHTML(entry.participant, "lb-stand-avatar")}
          <div class="lb-stand-name">${getDisplayName(entry.participant)}</div>
          <div class="lb-stand-meta">
            ${streakHTML(entry)}
            <span class="lb-stand-fine ${fineClass}">${fineDisplay}</span>
          </div>
        </div>
        <div class="lb-stand-block tier-${tier}">
          <span class="lb-stand-medal">${medal}</span>
        </div>
      </div>
    `;
  };

  const stage = document.createElement("div");
  stage.className = "lb-stage";
  stage.style.setProperty("--stand-count", ordered.length);
  stage.innerHTML = ordered.map(standHTML).join("");
  podiumEl.appendChild(stage);

  // -------- LEDGER (4th+) --------
  if (restEntries.length) {
    const ledger = document.createElement("div");
    ledger.className = "lb-ledger";
    ledger.innerHTML = `
      <div class="lb-ledger-head">
        <span>RANK</span><span></span><span>NAME</span><span>STREAK</span><span>FINES</span>
      </div>
      ${restEntries
        .map((entry) => {
          const { participant, totalFines, rank } = entry;
          const fineDisplay = totalFines === 0 ? "$0" : `$${totalFines}`;
          const fineClass = totalFines === 0 ? "zero" : "";
          return `
            <div class="lb-ledger-row">
              <span class="lb-ledger-rank">${String(rank).padStart(2, "0")}</span>
              ${avatarHTML(participant, "lb-ledger-avatar")}
              <span class="lb-ledger-name">${getDisplayName(participant)}</span>
              <span class="lb-ledger-streak">${streakHTML(entry)}</span>
              <span class="lb-ledger-fine ${fineClass}">${fineDisplay}</span>
            </div>`;
        })
        .join("")}
    `;
    container.appendChild(ledger);
  }
}

// ============================================================
// RENDER: WORKOUT TIMES CHART
// ============================================================

function getWorkoutTimesChartData() {
  // Build candidate 30-day window
  const allDays = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    allDays.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  }

  // Trim leading days where no participant has a completed workout
  let firstDataIdx = allDays.findIndex((dateStr) =>
    state.participants.some((p) => isWorkoutComplete(p.name, dateStr)),
  );
  const days = firstDataIdx <= 0 ? allDays : allDays.slice(firstDataIdx);

  return {
    days,
    series: state.participants.map((p) => {
      const color = getParticipantColor(p);
      const points = days.map((dateStr) => {
        if (!isWorkoutComplete(p.name, dateStr)) {
          // Off days (rest/sick) don't break the line; genuine misses do.
          return isOffDay(p.name, dateStr) ? "off" : null;
        }
        const completions = state.completions.filter(
          (c) =>
            c.date === dateStr &&
            c.person === p.name &&
            c.completed &&
            c.completedAt,
        );
        if (!completions.length) return null;
        const timestamps = completions
          .map((c) => new Date(c.completedAt).getTime())
          .filter((t) => !isNaN(t));
        if (!timestamps.length) return null;
        const latestMs = Math.max(...timestamps);
        const latestC = completions.find(
          (c) => new Date(c.completedAt).getTime() === latestMs,
        );
        const m = latestC.completedAt.match(/T(\d{2}):(\d{2})/);
        if (!m) return null;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      });
      return { name: getDisplayName(p), color, points };
    }),
  };
}

function renderWorkoutTimesChart() {
  const { days, series } = getWorkoutTimesChartData();
  const hasAnyData = series.some((s) =>
    s.points.some((p) => typeof p === "number"),
  );

  // Adaptive time range: zoom to actual data with padding, min 3h span
  const allMins = series.flatMap((s) =>
    s.points.filter((p) => typeof p === "number"),
  );
  let TMIN, TMAX;
  if (allMins.length) {
    TMIN = Math.max(0, Math.floor((Math.min(...allMins) - 45) / 60) * 60);
    TMAX = Math.min(1440, Math.ceil((Math.max(...allMins) + 45) / 60) * 60);
    if (TMAX - TMIN < 180) {
      const mid = (TMIN + TMAX) / 2;
      TMIN = Math.max(0, Math.round(mid / 60) * 60 - 90);
      TMAX = TMIN + 180;
    }
  } else {
    TMIN = 300;
    TMAX = 1380;
  }

  const W = 600;
  const H = 230;
  const PL = 50;
  const PR = 12;
  const PT = 16;
  const PB = 38;
  const CW = W - PL - PR;
  const CH = H - PT - PB;

  const xFor = (i) =>
    PL + (days.length > 1 ? (i / (days.length - 1)) * CW : CW / 2);
  const yFor = (mins) =>
    PT +
    (1 - (Math.min(Math.max(mins, TMIN), TMAX) - TMIN) / (TMAX - TMIN)) * CH;

  // Time grid + labels (every 2h within range)
  let grid = "";
  let timeLabels = "";
  for (let h = Math.ceil(TMIN / 60); h <= Math.floor(TMAX / 60); h += 2) {
    const y = yFor(h * 60);
    grid += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
    const lbl = String(h).padStart(2, "0");
    timeLabels += `<text x="${PL - 8}" y="${y + 4}" text-anchor="end" fill="#a5a5c8" font-size="12" font-weight="600">${lbl}</text>`;
  }

  // Date labels — every 7 days + last day, skip any that would collide (min 50px gap)
  const MIN_X_GAP = 50;
  let dateLabels = "";
  let lastLabelX = -Infinity;
  const xCandidates = [];
  for (let i = 0; i < days.length; i += 7) xCandidates.push(i);
  if (xCandidates[xCandidates.length - 1] !== days.length - 1)
    xCandidates.push(days.length - 1);
  for (const i of xCandidates) {
    const x = xFor(i);
    if (x - lastLabelX >= MIN_X_GAP) {
      const d = new Date(days[i] + "T00:00:00");
      const lbl = d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      dateLabels += `<text x="${x}" y="${H - PB + 18}" text-anchor="middle" fill="#a5a5c8" font-size="12" font-weight="600">${lbl}</text>`;
      lastLabelX = x;
    }
  }

  // Series
  let seriesSVG = "";
  if (hasAnyData) {
    for (const s of series) {
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          const pts = run.map(({ i, m }) => `${xFor(i)},${yFor(m)}`).join(" ");
          seriesSVG += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-opacity="0.65" stroke-linejoin="round" stroke-linecap="round"/>`;
        }
        run = [];
      };
      for (let i = 0; i < s.points.length; i++) {
        const p = s.points[i];
        if (typeof p === "number") run.push({ i, m: p });
        else if (p === null) flush(); // genuine miss breaks the line; "off" days don't
      }
      flush();

      for (let i = 0; i < s.points.length; i++) {
        const mins = s.points[i];
        if (typeof mins !== "number") continue;
        const hh = String(Math.floor(mins / 60)).padStart(2, "0");
        const mm = String(mins % 60).padStart(2, "0");
        seriesSVG += `<circle cx="${xFor(i)}" cy="${yFor(mins)}" r="3.5" fill="${s.color}" stroke="#0a0a0f" stroke-width="1.5"><title>${s.name}: ${hh}:${mm}</title></circle>`;
      }
    }
  }

  const legendItems = series
    .map(
      (s) =>
        `<span class="chart-legend-item"><svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="${s.color}"/></svg>${s.name}</span>`,
    )
    .join("");

  const emptyMsg = hasAnyData
    ? ""
    : `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#5a5a80" font-size="12">No workout data yet</text>`;

  return `
    <div class="workout-times-chart">
      <div class="workout-times-chart-header">
        <span class="workout-times-chart-title">Workout Times</span>
        <span class="workout-times-chart-sub">last ${days.length} day${days.length === 1 ? "" : "s"}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block;">
        ${grid}
        <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${H - PB}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
        <line x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
        ${timeLabels}
        ${dateLabels}
        ${seriesSVG}
        ${emptyMsg}
      </svg>
      <div class="chart-legend">${legendItems}</div>
    </div>
  `;
}

// ============================================================
// RENDER: HISTORY
// ============================================================

// Map a stored identity name → its base display name (never the "Plebeian"
// decoration), for the Hall of Dictators log.
function baseDisplayName(name) {
  const p = state.participants.find((x) => x.name === name);
  return (p && p.displayName && p.displayName.trim()) || name;
}

// Lazy, lightly-cached read of the `decrees` collection (only fetched when the
// History tab opens; ≤365 small docs over the challenge).
let _decreesCache = { ts: 0, docs: null };
async function getDecrees() {
  if (_decreesCache.docs && Date.now() - _decreesCache.ts < 60000)
    return _decreesCache.docs;
  const snap = await getDocs(collection(db, "decrees"));
  const docs = snap.docs.map((d) => ({ date: d.id, ...d.data() }));
  _decreesCache = { ts: Date.now(), docs };
  return docs;
}

// Read-only log of past reigns appended to the History tab.
async function renderHallOfDictators(parent) {
  if (!db) return;
  // Reuse the History "Reports" section shell so it sits flush with the other
  // history sections (same card, header, and inner-list rhythm).
  const section = document.createElement("section");
  section.className = "hh-reports hall-of-dictators";
  section.innerHTML = `
    <header class="hh-stats-head">
      <div class="hh-titleline">
        <h3 class="hh-section-title">Hall of Dictators</h3>
        <span class="hh-subhead">· daily reigns</span>
      </div>
    </header>`;
  const list = document.createElement("div");
  list.className = "hh-reports-list hall-list";
  const status = document.createElement("p");
  status.className = "hall-empty";
  status.textContent = "Loading reigns…";
  list.appendChild(status);
  section.appendChild(list);
  parent.appendChild(section);

  let decrees;
  try {
    decrees = await getDecrees();
  } catch {
    status.textContent = "Couldn't load reigns.";
    return;
  }

  const fmt = (dateStr) =>
    new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

  // Collapse consecutive calendar days under the same Dictator into one reign
  // (e.g. a 3-day run shows as a single "3-day reign" entry, not three rows).
  const dictOf = (d) => d.overrideDictator || d.dictator || null;
  const nextDay = (dateStr) => {
    const dt = new Date(dateStr + "T00:00:00");
    dt.setDate(dt.getDate() + 1);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };

  const chrono = decrees
    .filter((d) => dictOf(d)) // need a Dictator to attribute a reign
    .sort((a, b) => (a.date < b.date ? -1 : 1)); // oldest → newest

  const reigns = [];
  for (const d of chrono) {
    const dict = dictOf(d);
    const last = reigns[reigns.length - 1];
    if (last && last.dict === dict && nextDay(last.end) === d.date) {
      last.end = d.date;
      last.days += 1;
      if (d.pleb && !last.plebs.includes(d.pleb)) last.plebs.push(d.pleb);
      if (d.quote) last.quote = d.quote; // keep the latest quote of the reign
    } else {
      reigns.push({
        dict,
        start: d.date,
        end: d.date,
        days: 1,
        plebs: d.pleb ? [d.pleb] : [],
        quote: d.quote || "",
      });
    }
  }
  reigns.reverse(); // newest reign first

  if (!reigns.length) {
    status.textContent = "No reigns yet — nobody's worn the crown.";
    return;
  }

  list.textContent = "";
  reigns.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "hall-reign";
    row.style.setProperty("--i", i); // staggered reveal

    const crown = document.createElement("span");
    crown.className = "hall-reign-crown";
    crown.textContent = "👑";

    const body = document.createElement("div");
    body.className = "hall-reign-body";

    const top = document.createElement("div");
    top.className = "hall-reign-top";

    const dict = document.createElement("span");
    dict.className = "hall-reign-dict";
    dict.textContent = baseDisplayName(r.dict);
    top.appendChild(dict);

    if (r.days > 1) {
      const streak = document.createElement("span");
      streak.className = "hall-reign-streak";
      streak.textContent = `${r.days}-day reign`;
      top.appendChild(streak);
    }

    const verdict = document.createElement("span");
    verdict.className = "hall-reign-verdict";
    if (r.plebs.length) {
      verdict.append("demoted ");
      r.plebs.forEach((name, idx) => {
        const pleb = document.createElement("span");
        pleb.className = "hall-reign-pleb";
        pleb.textContent = baseDisplayName(name);
        verdict.appendChild(pleb);
        if (idx < r.plebs.length - 1) verdict.append(" · ");
      });
    } else {
      verdict.textContent = "ruled mercifully";
      verdict.classList.add("merciful");
    }
    top.appendChild(verdict);
    body.appendChild(top);

    if (r.quote) {
      const q = document.createElement("p");
      q.className = "hall-reign-quote";
      q.textContent = `“${r.quote}”`;
      body.appendChild(q);
    }

    const date = document.createElement("time");
    date.className = "hall-reign-date";
    date.textContent =
      r.days > 1 ? `${fmt(r.start)} – ${fmt(r.end)}` : fmt(r.start);

    row.append(crown, body, date);
    list.appendChild(row);
  });
}

async function renderHistory() {
  const container = document.getElementById("history-container");
  container.innerHTML = "";

  const WINDOW = 90;
  const toDateStr = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Build a single shared timeline of WINDOW days, oldest → newest.
  const todayLocal = new Date();
  const days = [];
  for (let i = WINDOW - 1; i >= 0; i--) {
    const d = new Date(todayLocal);
    d.setDate(d.getDate() - i);
    days.push(toDateStr(d));
  }

  // Per-day width = cell + left margin (default gap, week gap, or month gap).
  const CELL_W = 14;
  const DEFAULT_GAP = 2;
  const WEEK_GAP = 8;
  const MONTH_GAP = 12;
  const dayMeta = days.map((d, i) => {
    const dt = new Date(d + "T00:00:00");
    const isMonthStart = i > 0 && d.slice(8) === "01";
    const isWeekStart = i > 0 && !isMonthStart && dt.getDay() === 1;
    const leftGap =
      i === 0
        ? 0
        : isMonthStart
          ? MONTH_GAP
          : isWeekStart
            ? WEEK_GAP
            : DEFAULT_GAP;
    return { isMonthStart, isWeekStart, leftGap, width: CELL_W + leftGap };
  });

  // Group days into month spans + compute pixel width per month segment.
  const monthSpans = [];
  for (let i = 0; i < days.length; ) {
    const key = days[i].slice(0, 7);
    let j = i;
    while (j < days.length && days[j].slice(0, 7) === key) j++;
    let width = 0;
    for (let k = i; k < j; k++) width += dayMeta[k].width;
    monthSpans.push({ key, span: j - i, width });
    i = j;
  }
  const monthLabel = (key) =>
    new Date(key + "-01T00:00:00").toLocaleDateString("en-US", {
      month: "short",
    });

  const fmtFullDate = (dateStr) =>
    new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });

  // ----- Per-participant computation -----
  const rows = state.participants.map((p) => {
    const color = getParticipantColor(p);
    const tz = p.timezoneOffset;
    const pToday = tz != null ? getTodayStrForOffset(tz) : state.todayStr;
    const joined = p.joinedDate || days[0];

    // Per-cell state
    const cells = days.map((date) => {
      if (date < joined) return { date, state: "pre" };
      if (date > pToday) return { date, state: "pre" }; // future for them
      const isToday = date === pToday;
      const sick = isSickDay(p.name, date);
      const rest = isRestDay(p.name, date);
      const done = getCompletedExercisesForDay(p.name, date);
      const allComplete = done.length === CONFIG.EXERCISES.length;
      if (allComplete)
        return {
          date,
          state: "done",
          done: done.length,
          time: getWorkoutCompletionTime(p.name, date),
        };
      if (sick) return { date, state: "sick" };
      if (rest) return { date, state: "rest" };
      if (isToday) return { date, state: "today", done: done.length };
      if (done.length > 0) return { date, state: "partial", done: done.length };
      return { date, state: "miss" };
    });

    // Summary stats
    const totalFines = calcFinesForPersonAllTime(p.name);
    const streak = calcStreak(p.name);
    const bestStreak = calcBestStreak(p.name);
    const completedDays = cells.filter((c) => c.state === "done").length;
    const eligibleDays = cells.filter(
      (c) =>
        c.state === "done" ||
        c.state === "miss" ||
        c.state === "partial" ||
        c.state === "rest",
    ).length;
    const rate =
      eligibleDays > 0 ? Math.round((completedDays / eligibleDays) * 100) : 100;

    let earliestMins = p.earliestWorkoutMinutes ?? null;
    let latestMins = p.latestWorkoutMinutes ?? null;
    for (const c of cells) {
      if (!c.time) continue;
      const m = parseTimeLabelToMinutes(c.time);
      if (m == null) continue;
      if (earliestMins == null || m < earliestMins) earliestMins = m;
      if (latestMins == null || m > latestMins) latestMins = m;
    }

    return {
      participant: p,
      color,
      cells,
      stats: {
        totalFines,
        streak,
        bestStreak,
        completedDays,
        rate,
        earliest: formatMinutesToTimeLabel(earliestMins),
        latest: formatMinutesToTimeLabel(latestMins),
      },
    };
  });

  // Sort: highest completion rate first, ties broken by current streak
  const ranked = rows
    .slice()
    .sort(
      (a, b) =>
        b.stats.rate - a.stats.rate ||
        b.stats.streak - a.stats.streak ||
        b.stats.completedDays - a.stats.completedDays,
    );

  // ----- HEAT MAP HTML -----
  const monthAxis = monthSpans
    .map(
      (m) =>
        `<div class="hh-month-seg" style="width:${m.width}px;"><span class="hh-month-cell">${monthLabel(m.key)}</span></div>`,
    )
    .join("");

  const cellsHTML = (rowIdx, cells) =>
    cells
      .map((c, i) => {
        const meta = dayMeta[i];
        const divCls = meta.isMonthStart
          ? " hh-mstart"
          : meta.isWeekStart
            ? " hh-wstart"
            : "";
        const style = meta.leftGap
          ? ` style="margin-left:${meta.leftGap}px;"`
          : "";
        return `<button type="button" class="hh-cell hh-c-${c.state}${divCls}"${style} data-row="${rowIdx}" data-i="${i}" aria-label="${fmtFullDate(c.date)} — ${c.state}"></button>`;
      })
      .join("");

  // One grid row per person: name cell + cells cell as siblings
  const personRowsHTML = ranked
    .map(
      (r, idx) => `
    <div class="hh-name-row" style="--c:${r.color};">
      ${avatarHTML(r.participant, "hh-avatar")}
      <div class="hh-person-name">${getDisplayName(r.participant)}</div>
    </div>
    <div class="hh-cell-row">${cellsHTML(idx, r.cells)}</div>
  `,
    )
    .join("");

  // ----- COMBINED STATS TABLE -----
  const tableRowsHTML = ranked
    .map(
      (r) => `
    <tr style="--c:${r.color};">
      <th scope="row" class="hh-t-person">
        <div class="hh-t-person-inner">
          ${avatarHTML(r.participant, "hh-t-avatar")}
          <span class="hh-t-name">${getDisplayName(r.participant)}</span>
        </div>
      </th>
      <td class="hh-t-fines">${r.stats.totalFines > 0 ? `$${r.stats.totalFines}` : "$0"}</td>
      <td class="hh-t-rate">${r.stats.rate}%</td>
      <td class="hh-t-days">${r.stats.completedDays}</td>
      <td class="hh-t-best">${r.stats.bestStreak > 0 ? r.stats.bestStreak : "—"}</td>
      <td class="hh-t-time">${r.stats.earliest}</td>
      <td class="hh-t-time">${r.stats.latest}</td>
    </tr>
  `,
    )
    .join("");

  const tableHTML = `
    <table class="hh-table">
      <thead>
        <tr>
          <th></th>
          <th>Fines</th>
          <th>Rate</th>
          <th>Days</th>
          <th>Best</th>
          <th>Earliest</th>
          <th>Latest</th>
        </tr>
      </thead>
      <tbody>${tableRowsHTML}</tbody>
    </table>
  `;

  container.innerHTML = `
    <section class="hh-wall">
      <header class="hh-wall-head">
        <div class="hh-titleline">
          <h3 class="hh-section-title">Receipts</h3>
          <span class="hh-subhead">· last ${WINDOW} days</span>
        </div>
        <div class="hh-legend">
          <span><i class="lg lg-done"></i>done</span>
          <span><i class="lg lg-partial"></i>partial</span>
          <span><i class="lg lg-miss"></i>missed</span>
          <span><i class="lg lg-sick"></i>sick</span>
          <span><i class="lg lg-rest"></i>rest</span>
        </div>
      </header>
      <div class="hh-wall-scroll" id="hh-wall-scroll">
        <div class="hh-wall-grid">
          <div class="hh-axis-spacer"></div>
          <div class="hh-month-axis">${monthAxis}</div>
          ${personRowsHTML}
        </div>
      </div>
      <div class="hh-detail" id="hh-detail" data-empty="1">
        Tap any square for details
      </div>
    </section>

    <section class="hh-stats">
      <header class="hh-stats-head">
        <div class="hh-titleline">
          <h3 class="hh-section-title">Score sheet</h3>
          <span class="hh-subhead">· all-time</span>
        </div>
      </header>
      <div class="hh-table-scroll">${tableHTML}</div>
    </section>
  `;

  // Auto-scroll heat map to the right edge so "today" is in view.
  const scroller = container.querySelector("#hh-wall-scroll");
  requestAnimationFrame(() => {
    scroller.scrollLeft = scroller.scrollWidth;
  });

  // Cell tap → detail bar
  const detail = container.querySelector("#hh-detail");
  const stateLabel = {
    done: "completed",
    partial: "partial",
    miss: "skipped — fined",
    sick: "🤒 sick day",
    rest: "🏖️ rest day",
    today: "in progress",
    pre: "not started",
  };
  container.querySelector(".hh-wall-grid").addEventListener("click", (e) => {
    const btn = e.target.closest(".hh-cell");
    if (!btn) return;
    const rowIdx = parseInt(btn.dataset.row, 10);
    const i = parseInt(btn.dataset.i, 10);
    const row = ranked[rowIdx];
    const cell = row.cells[i];
    let extra = "";
    if (cell.state === "done" && cell.time) extra = ` · ${cell.time}`;
    else if (cell.state === "partial")
      extra = ` · ${cell.done}/${CONFIG.EXERCISES.length} done`;
    else if (cell.state === "today" && cell.done)
      extra = ` · ${cell.done}/${CONFIG.EXERCISES.length} so far`;
    detail.removeAttribute("data-empty");
    detail.innerHTML = `
      <strong>${getDisplayName(row.participant)}</strong>
      <span class="hh-detail-date">${fmtFullDate(cell.date)}</span>
      <span class="hh-detail-state hh-d-${cell.state}">${stateLabel[cell.state]}${extra}</span>
    `;
    container
      .querySelectorAll(".hh-cell.is-active")
      .forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
  });

  // Dictator feature: append the read-only Hall of Dictators log.
  renderHallOfDictators(container);
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
      <span class="admin-name">${getDisplayName(p)}${getDisplayName(p) !== p.name ? ` <span style="font-size:0.65rem;opacity:0.5;font-weight:400;">(${p.name})</span>` : ""}${p.isAdmin ? ' <span style="font-size:0.65rem;background:rgba(108,99,255,0.2);color:var(--accent);padding:2px 6px;border-radius:4px;font-weight:700;">ADMIN</span>' : ""}</span>
      <span style="font-size:0.8rem;color:var(--danger);font-weight:700;font-family:var(--font-mono);">
        ${fine > 0 ? `$${fine}` : "$0"}
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

  renderDictatorAdminPicker();
  renderUsageHourChart(); // usage analytics: opens-by-hour histogram (async)
}

// Admin control: crown a specific participant as today's Dictator, or hand it
// back to the random election. Stored as `overrideDictator` on today's decree.
function renderDictatorAdminPicker() {
  const picker = document.getElementById("dictator-admin-picker");
  const hint = document.getElementById("dictator-admin-hint");
  if (!picker) return;

  const today = getUTCTodayStr();
  const override =
    state.decree && state.decree.date === today
      ? state.decree.overrideDictator
      : null;
  const active = currentDictator();

  if (hint) {
    hint.textContent = override
      ? "Override active — you've hand-picked today's Dictator."
      : "Random by default. Tap a name to crown someone for today instead.";
  }

  picker.innerHTML = "";

  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "dictator-pick" + (override ? "" : " active");
  autoBtn.textContent = "🎲 Random";
  autoBtn.addEventListener("click", () => setOverrideDictator(null));
  picker.appendChild(autoBtn);

  state.participants.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const base = (p.displayName && p.displayName.trim()) || p.name;
    const isActive = p.name === active;
    btn.className = "dictator-pick" + (override === p.name ? " active" : "");
    btn.textContent = (isActive ? "👑 " : "") + base;
    btn.addEventListener("click", () => setOverrideDictator(p.name));
    picker.appendChild(btn);
  });
}

// Write (or clear) the override. Passing null hands the crown back to random.
async function setOverrideDictator(name) {
  if (!db) return;
  const date = getUTCTodayStr();
  const prev = state.decree;
  const base = state.decree && state.decree.date === date ? state.decree : { date };
  // null override is treated as "no override" by currentDictator() — no
  // deleteField() needed, keeps the import surface unchanged.
  state.decree = { ...base, date, overrideDictator: name || null };
  renderAdmin();

  try {
    await setDoc(
      doc(db, "decrees", date),
      { overrideDictator: name || null },
      { merge: true },
    );
    showToast(
      name
        ? `${name} crowned Dictator for today 👑`
        : "Dictator handed back to random 🎲",
      "success",
    );
  } catch (err) {
    state.decree = prev;
    renderAdmin();
    showToast("Failed to update Dictator: " + err.message, "error");
  }
}

// ============================================================
// RENDER: HEADER
// ============================================================

function renderHeader() {
  if (!state.currentUser) return;
  const me =
    state.participants.find((p) => p.name === state.currentUser.name) ||
    state.currentUser;
  const color = getParticipantColor(state.currentUser);
  const avatarEl = document.getElementById("header-avatar");
  avatarEl.style.background = color;
  const badge = royalBadgeHTML(me);
  avatarEl.style.position = badge ? "relative" : "";
  if (state.currentUser.avatar) {
    avatarEl.style.padding = "0";
    avatarEl.style.overflow = badge ? "visible" : "hidden";
    avatarEl.innerHTML = `<img src="${state.currentUser.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="${getDisplayName(me)}">${badge}`;
  } else {
    avatarEl.style.padding = "";
    avatarEl.style.overflow = badge ? "visible" : "";
    avatarEl.innerHTML = `${getInitials(getDisplayName(me))}${badge}`;
  }
  document.getElementById("header-name").textContent = "Profile";
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
  startDeadlineTicker();
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
    floatAlan.style.display =
      viewId === "leaderboard" || viewId === "history" ? "block" : "none";
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
    img.src = "/alan/alan_cheer.png";
    img.alt = "";
    todayHeader.appendChild(img);
  }
  if (!document.getElementById("glory-alan-float")) {
    const img = document.createElement("img");
    img.id = "glory-alan-float";
    img.src = "/alan/alan_cheer.png";
    img.alt = "";
    img.dataset.tapCount = "0";
    img.addEventListener("click", handleAlanTap);
    document.body.appendChild(img);
  }
}

const ALAN_QUIPS = [
  "Just raw dog it",
  "🍑",
  "Choose your hard",
  "Pica?",
  "I'm doing something back here",
  "Ready for a smash fest",
  "To be sure, to be sure",
  "I'm a fat person in a skinny person's body",
];

const ALAN_SCARED_QUIPS = [
  "Please no more...",
  "Legs are a bit sore hey",
  "🌚",
];

const ALAN_TIRED_QUIPS = ["I bonked..", "...", "🌚"];

const ALAN_EXPRESSIONS = [
  "/alan/alan_heart.png",
  "/alan/alan_neutral.png",
  "/alan/alan_cheer.png",
];

const ALAN_SCARED_THRESHOLD = 10;
const ALAN_TIRED_THRESHOLD = 12;
const ALAN_RESET_MS = 30000;

function setAlanExpression(src) {
  const float = document.getElementById("glory-alan-float");
  if (float) float.src = src;
  const todayAlan = document.querySelector(".glory-today-alan");
  if (todayAlan) todayAlan.src = src;
}

function handleAlanTap(e) {
  const alan = e.currentTarget;
  if (!alan) return;

  const tapCount = parseInt(alan.dataset.tapCount ?? "0") + 1;
  alan.dataset.tapCount = tapCount;

  // Reset to neutral after 30s of no tapping
  clearTimeout(alan._resetTimer);
  alan._resetTimer = setTimeout(() => {
    alan.dataset.tapCount = "0";
    setAlanExpression("/alan/alan_neutral.png");
  }, ALAN_RESET_MS);

  // Update expression
  if (tapCount >= ALAN_TIRED_THRESHOLD) {
    setAlanExpression("/alan/alan_tired.png");
  } else if (tapCount >= ALAN_SCARED_THRESHOLD) {
    setAlanExpression("/alan/alan_scared.png");
  } else {
    setAlanExpression(
      ALAN_EXPRESSIONS[(tapCount - 1) % ALAN_EXPRESSIONS.length],
    );
  }

  // Wiggle
  alan.classList.remove("wiggling");
  void alan.offsetWidth;
  alan.classList.add("wiggling");
  alan.addEventListener(
    "animationend",
    () => alan.classList.remove("wiggling"),
    { once: true },
  );

  // Sound
  playAlanBoing();

  // Quip bubble
  const pool =
    tapCount >= ALAN_TIRED_THRESHOLD
      ? ALAN_TIRED_QUIPS
      : tapCount >= ALAN_SCARED_THRESHOLD
        ? ALAN_SCARED_QUIPS
        : ALAN_QUIPS;
  const quip = pool[Math.floor(Math.random() * pool.length)];
  const bubble = document.createElement("div");
  bubble.className = "alan-quip";
  bubble.textContent = quip;
  const rect = alan.getBoundingClientRect();
  bubble.style.bottom = window.innerHeight - rect.top + 8 + "px";
  bubble.style.right = window.innerWidth - rect.right + 8 + "px";
  document.body.appendChild(bubble);
  bubble.addEventListener("animationend", () => bubble.remove());
}

function playAlanBoing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.08);
    osc.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.25);
    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {}
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

function playCounterInc() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(520, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(780, ctx.currentTime + 0.07);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  } catch {}
}

function playCounterDec() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(420, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(280, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.09, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  } catch {}
}

function playExerciseTick() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.06);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12);
  } catch {}
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
        ? `<img src="${p.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="${getDisplayName(p)}">`
        : getInitials(getDisplayName(p));
      return `
      <div class="glory-avatar-wrap" style="animation-delay:${i * 0.3}s">
        <div class="glory-avatar" style="background:${color};">${inner}</div>
        <div class="glory-name">${getDisplayName(p).split(" ")[0]}</div>
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
// DICTATOR — appointment popup + demotion
// ============================================================

// Once-per-UTC-day guard for the appointment popup (key is the date itself, so
// it naturally resets when the day rolls over).
function dictatorPopupSeen() {
  try {
    return localStorage.getItem("np_dictator_seen") === getUTCTodayStr();
  } catch {
    return false;
  }
}
function markDictatorPopupSeen() {
  try {
    localStorage.setItem("np_dictator_seen", getUTCTodayStr());
  } catch {}
}

// Guards against two concurrent callers (decree snapshot + showApp/rollover)
// both awaiting refreshReignPlebs and then each opening a popup.
let _dictatorPopupPending = false;

// Show the appointment popup iff the logged-in user is today's Dictator, hasn't
// already declared today's pleb (on ANY device — Firestore is the source of
// truth, not the per-device "seen" flag), and hasn't dismissed it yet today.
async function maybeShowDictatorPopup() {
  if (!state.currentUser) return;
  if (currentDictator() !== state.currentUser.name) return;
  // Wait until today's decree has actually loaded, otherwise we can't tell
  // whether a pleb was already declared elsewhere. The decree listener re-calls
  // this once the snapshot arrives.
  if (!state.decree || state.decree.date !== getUTCTodayStr()) return;
  if (currentPleb()) return; // already demoted someone today (any device)
  if (dictatorPopupSeen()) return;
  if (document.querySelector(".dictator-overlay")) return;
  if (_dictatorPopupPending) return;

  // Make sure the plebs accumulated on earlier reign days are loaded BEFORE we
  // build the chooser — otherwise (e.g. on day 3 of a reign) state.reignPlebs is
  // still empty and the popup would offer already-demoted teammates again.
  _dictatorPopupPending = true;
  try {
    await refreshReignPlebs();
  } finally {
    _dictatorPopupPending = false;
  }

  // Re-check the guards: the await above yields, so state (and the DOM) may have
  // changed in the meantime.
  if (!state.currentUser) return;
  if (currentDictator() !== state.currentUser.name) return;
  if (currentPleb()) return;
  if (dictatorPopupSeen()) return;
  if (document.querySelector(".dictator-overlay")) return;
  // NOTE: we deliberately do NOT mark the popup "seen" here. It's marked only
  // once the Dictator actually decides (demote or the absolute-reign dismiss),
  // so closing the app without choosing lets it re-appear on next open.
  showDictatorPopup();
}

function showDictatorPopup() {
  document.querySelector(".dictator-overlay")?.remove();

  const me = state.currentUser.name;
  // Strictly additive: hide teammates already demoted earlier in this reign so
  // the Dictator picks a NEW victim each day (1/day, building up).
  const alreadyPlebs = currentPlebs();
  const others = state.participants.filter(
    (p) => p.name !== me && !alreadyPlebs.has(p.name),
  );
  const reigning = alreadyPlebs.size > 0;

  const overlay = document.createElement("div");
  overlay.className = "group-complete-overlay dictator-overlay";

  const choicesHTML = others
    .map((p) => {
      const color = getParticipantColor(p);
      // Use the raw name here, not getDisplayName (which would say "Plebeian"
      // for an already-demoted teammate).
      const base = (p.displayName && p.displayName.trim()) || p.name;
      const inner = p.avatar
        ? `<img src="${p.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="${base}">`
        : getInitials(base);
      return `<button class="dictator-choice" data-demote="${p.name}">
          <span class="dictator-choice-av" style="background:${color};">${inner}</span>
          <span class="dictator-choice-name">${base}</span>
        </button>`;
    })
    .join("");

  // When everyone else is already a Plebeian (e.g. day 4 of a reign that already
  // demoted all peasants) there's no one left to demote — show an acknowledgment
  // with a single dismiss button instead of an empty chooser.
  const hasChoices = others.length > 0;
  const subtitle = !hasChoices
    ? `Your reign is absolute — everyone is already a <strong>Plebeian</strong>. 👑`
    : reigning
      ? `Your reign continues.<br>Demote one more peasant to <strong>Plebeian</strong>:`
      : `You have been appointed Dictator for the day.<br>Demote one peasant to <strong>Plebeian</strong>:`;

  overlay.innerHTML = `
    <h1 class="glory-title">👑 DICTATOR 👑</h1>
    <p class="glory-subtitle">${subtitle}</p>
    ${
      hasChoices
        ? `<div class="dictator-choices">${choicesHTML}</div>`
        : `<button class="dictator-skip" data-skip="1">Long live the reign 👑</button>`
    }
  `;

  const dismiss = () => {
    overlay.style.transition = "opacity 0.4s";
    overlay.style.opacity = "0";
    setTimeout(() => overlay.remove(), 400);
  };

  // Require a deliberate demotion (no more "spare them all"); the only non-demote
  // exit is the dismiss button shown when everyone is already a Plebeian.
  // Backdrop taps don't dismiss.
  overlay.addEventListener("click", (e) => {
    const demoteBtn = e.target.closest("[data-demote]");
    if (demoteBtn) {
      // A deliberate decision was made — mark seen so it doesn't re-pop today.
      // (decreeDemotion also sets currentPleb, which suppresses it cross-device.)
      markDictatorPopupSeen();
      decreeDemotion(demoteBtn.getAttribute("data-demote"));
      dismiss();
    } else if (e.target.closest("[data-skip]")) {
      // Absolute-reign acknowledgment (no one left to demote, no Firestore
      // write) — mark seen so this device stops re-showing it today.
      markDictatorPopupSeen();
      dismiss();
    }
  });

  document.body.appendChild(overlay);
}

// The Dictator demotes a teammate to Plebeian for the day. Optimistic write to
// the day's decree doc (merge so it doesn't clobber an existing quote).
async function decreeDemotion(targetName) {
  if (!state.currentUser || !db) return;
  const me = state.currentUser.name;
  if (currentDictator() !== me) return; // only today's Dictator may demote
  if (currentPlebs().has(targetName)) return; // already a Plebeian this reign
  const date = getUTCTodayStr();
  const prev = state.decree;
  const quote =
    (state.decree && state.decree.date === date && state.decree.quote) || "";

  state.decree = { date, dictator: me, pleb: targetName, quote };
  renderCurrentView();
  showToast(`${targetName} has been demoted to Plebeian`, "info");

  try {
    await setDoc(
      doc(db, "decrees", date),
      { dictator: me, pleb: targetName, quote },
      { merge: true },
    );
  } catch (err) {
    state.decree = prev;
    renderCurrentView();
    showToast("Failed to demote: " + err.message, "error");
  }
}

// Quote of the day — a "royal proclamation" pull-quote on the Today page.
// It's STICKY (state.dictatorQuote from settings/app): the last decreed quote
// stays put across days until a Dictator overwrites it. Today's Dictator edits
// it inline; everyone else reads it (hidden only when no quote has ever been set
// and the viewer isn't the Dictator).
function renderDictatorQuote(container) {
  const q = state.dictatorQuote; // { text, by } | null
  const dictator = currentDictator();
  const isDictator =
    state.currentUser && state.currentUser.name === dictator;
  if (!q && !isDictator) return;

  const el = document.createElement("div");
  el.className = "proclamation" + (isDictator ? " editable" : "");

  const mark = document.createElement("span");
  mark.className = "proclamation-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "“";

  const text = document.createElement("p");
  text.className = "proclamation-text";
  if (q && q.text) {
    text.textContent = q.text;
  } else {
    text.classList.add("placeholder");
    text.textContent = "Decree your quote of the day…";
  }
  el.append(mark, text);

  if (q && q.text) {
    const by = document.createElement("div");
    by.className = "proclamation-by";
    const seal = document.createElement("span");
    seal.className = "proclamation-seal";
    seal.setAttribute("aria-hidden", "true");
    seal.textContent = "👑";
    const who = document.createElement("span");
    who.className = "proclamation-author";
    who.textContent =
      q.by && state.currentUser && q.by === state.currentUser.name
        ? "You"
        : baseDisplayName(q.by || dictator);
    by.append(seal, who);
    el.appendChild(by);
  }

  if (isDictator) {
    const editCue = document.createElement("button");
    editCue.type = "button";
    editCue.className = "proclamation-edit-cue";
    editCue.title = "Edit regime reminder";
    editCue.setAttribute("aria-label", "Edit regime reminder");
    editCue.textContent = "✎";
    el.appendChild(editCue);

    text.setAttribute("role", "button");
    text.tabIndex = 0;
    text.title = "Tap to edit the regime reminder";
    const startEdit = () => {
      const target = el.querySelector(".proclamation-text");
      if (target) editDictatorQuote(target);
    };
    text.addEventListener("click", startEdit);
    editCue.addEventListener("click", startEdit);
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startEdit();
      }
    });
  }

  container.prepend(el);
}

function editDictatorQuote(span) {
  const me = state.currentUser?.name;
  if (!me || currentDictator() !== me) return;

  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 140;
  input.value = state.dictatorQuote?.text || "";
  input.className = "proclamation-input";
  input.placeholder = "Your quote of the day…";
  span.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    saveDictatorQuote(input.value.trim());
    renderTodayView();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      input.removeEventListener("blur", commit);
      done = true;
      renderTodayView();
    }
  });
}

// Save the quote. Primary write is the sticky settings doc (persists across
// days, open write rules); we also stamp today's decree for the Hall log.
async function saveDictatorQuote(text) {
  if (!state.currentUser || !db) return;
  const me = state.currentUser.name;
  if (currentDictator() !== me) return;
  const date = getUTCTodayStr();
  const prev = state.dictatorQuote;
  state.dictatorQuote = text ? { text, by: me } : null;

  try {
    await setDoc(
      doc(db, "settings", "app"),
      { dictatorQuote: text ? { text, by: me } : null },
      { merge: true },
    );
  } catch (err) {
    state.dictatorQuote = prev;
    renderTodayView();
    showToast("Failed to save quote: " + err.message, "error");
    return;
  }
  // Best-effort: record this reign's quote on today's decree for the Hall.
  setDoc(
    doc(db, "decrees", date),
    { dictator: me, quote: text },
    { merge: true },
  ).catch(() => {});
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

function syncTimezoneOffset() {
  if (!state.currentUser || !db) return;
  const tz = new Date().getTimezoneOffset();
  if (tz === state.currentUser.timezoneOffset) return;
  state.currentUser.timezoneOffset = tz;
  localStorage.setItem("np_current_user", JSON.stringify(state.currentUser));
  const p = state.participants.find((p) => p.name === state.currentUser.name);
  if (p) p.timezoneOffset = tz;
  updateDoc(doc(db, "participants", state.currentUser.name), {
    timezoneOffset: tz,
  }).catch(() => {});
}

// ============================================================
// USAGE ANALYTICS — capture each app open, per person per local day.
// Duration is NOT tracked (just the timestamp of every open). Append-only via
// arrayUnion, so there's no read and no read-modify-write. Rapid re-focuses
// within 30 min of the same day count as one session and aren't double-logged.
// Doc: analytics/{YYYY-MM-DD}_{name} = { date, person, tzOffset, device,
// updatedAt, openTimes: [<local ISO>, ...] }.
// ============================================================
let _lastUsageOpenMs = 0;
let _lastUsageDay = "";

function recordUsageOpen() {
  if (!db || !state.currentUser) return; // never track logged-out screens
  const today = getTodayStr();
  const now = Date.now();
  // Same session (re-focus within 30 min on the same day) → don't double-count.
  if (today === _lastUsageDay && now - _lastUsageOpenMs < 30 * 60 * 1000) return;
  _lastUsageOpenMs = now;
  _lastUsageDay = today;

  const name = state.currentUser.name;
  const nowIso = localISOString(new Date());
  setDoc(
    doc(db, "analytics", `${today}_${name}`),
    {
      date: today,
      person: name,
      tzOffset:
        state.currentUser.timezoneOffset ?? new Date().getTimezoneOffset(),
      device: navigator.userAgent.slice(0, 80),
      updatedAt: nowIso,
      openTimes: arrayUnion(nowIso),
    },
    { merge: true },
  ).catch(() => {}); // fire-and-forget, like syncTimezoneOffset
}

// Lightly-cached read of recent usage docs (admin chart only). ~4 users × 7
// days ≈ 28 small docs, 60s-cached, so opening the Admin tab is cheap.
let _analyticsCache = { ts: 0, docs: null };
async function getRecentAnalytics(fromDate) {
  if (_analyticsCache.docs && Date.now() - _analyticsCache.ts < 60000)
    return _analyticsCache.docs;
  const snap = await getDocs(
    query(collection(db, "analytics"), where("date", ">=", fromDate)),
  );
  const docs = snap.docs.map((d) => d.data());
  _analyticsCache = { ts: Date.now(), docs };
  return docs;
}

// Admin "Opens by hour" chart: a stacked bar graph with one bar per hour,
// each bar segmented by person and summed over the last 7 days. Each openTime
// stores the person's own local time, so the hour is read straight off the ISO
// string (chars 11–12), matching getWorkoutTimesChartData's approach.
async function renderUsageHourChart() {
  const el = document.getElementById("usage-hour-chart");
  if (!el || !db) return;
  el.innerHTML = `<p class="uhc-empty">Loading…</p>`;

  let docs;
  try {
    docs = await getRecentAnalytics(dateStrDaysAgo(6)); // today + prior 6 = 7 days
  } catch {
    el.innerHTML = `<p class="uhc-empty">Couldn't load usage data.</p>`;
    return;
  }

  // Per-person hourly open counts (24 buckets), summed over the window.
  const series = state.participants.map((p) => {
    const counts = new Array(24).fill(0);
    for (const d of docs) {
      if (d.person !== p.name) continue;
      for (const t of d.openTimes || []) {
        const hh = parseInt(String(t).slice(11, 13), 10);
        if (hh >= 0 && hh <= 23) counts[hh]++;
      }
    }
    return { name: getDisplayName(p), color: getParticipantColor(p), counts };
  });

  const total = series.reduce(
    (sum, s) => sum + s.counts.reduce((a, b) => a + b, 0),
    0,
  );
  if (!total) {
    el.innerHTML = `<p class="uhc-empty">No opens recorded yet.</p>`;
    return;
  }

  // Total opens per hour (height of each stacked bar)
  const hourTotals = new Array(24)
    .fill(0)
    .map((_, h) => series.reduce((sum, s) => sum + s.counts[h], 0));
  const maxCount = Math.max(1, ...hourTotals);

  const W = 600,
    H = 200,
    PL = 30,
    PR = 12,
    PT = 14,
    PB = 30;
  const CW = W - PL - PR;
  const CH = H - PT - PB;
  // Each hour gets an evenly-spaced slot; the bar is centred in its slot.
  const slotW = CW / 24;
  const barW = slotW * 0.7;
  const xFor = (h) => PL + (h + 0.5) * slotW;
  const yFor = (c) => PT + (1 - c / maxCount) * CH;

  // Horizontal grid + integer Y labels (~4 ticks)
  const step = Math.max(1, Math.ceil(maxCount / 4));
  let grid = "";
  let yLabels = "";
  for (let c = 0; c <= maxCount; c += step) {
    const y = yFor(c);
    grid += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;
    yLabels += `<text x="${PL - 6}" y="${y + 4}" text-anchor="end" fill="#a5a5c8" font-size="11" font-weight="600">${c}</text>`;
  }

  // X labels every 6h + the final hour
  let xLabels = "";
  for (const h of [0, 6, 12, 18, 23]) {
    xLabels += `<text x="${xFor(h)}" y="${H - PB + 18}" text-anchor="middle" fill="#a5a5c8" font-size="11" font-weight="600">${String(h).padStart(2, "0")}</text>`;
  }

  // One stacked bar per hour: each person is a coloured segment, stacked from
  // the baseline up. Each segment carries a hover detail.
  let seriesSVG = "";
  for (let h = 0; h < 24; h++) {
    if (!hourTotals[h]) continue;
    const x = xFor(h) - barW / 2;
    let cum = 0;
    for (const s of series) {
      const c = s.counts[h];
      if (!c) continue;
      const yTop = yFor(cum + c);
      const segH = yFor(cum) - yTop;
      cum += c;
      seriesSVG += `<rect x="${x}" y="${yTop}" width="${barW}" height="${segH}" fill="${s.color}" fill-opacity="0.9" rx="1"><title>${s.name}: ${String(h).padStart(2, "0")}:00 — ${c} open${c === 1 ? "" : "s"}</title></rect>`;
    }
  }

  const legend = series
    .map(
      (s) =>
        `<span class="chart-legend-item"><svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="${s.color}"/></svg>${s.name}</span>`,
    )
    .join("");

  el.innerHTML = `
    <div class="uhc-head">
      <span class="uhc-title">Opens by hour</span>
      <span class="uhc-sub">last 7 days · ${total} open${total === 1 ? "" : "s"}</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block;">
      ${grid}
      <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${H - PB}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
      <line x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
      ${yLabels}
      ${xLabels}
      ${seriesSVG}
    </svg>
    <div class="chart-legend">${legend}</div>
    <div class="uhc-foot">each member's local time</div>
  `;
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
  syncTimezoneOffset();
  recordUsageOpen(); // usage analytics: log this app open
  refreshReignPlebs(); // Dictator feature: carry earlier-reign plebs into today's view
  maybeShowDictatorPopup(); // Dictator feature: offer demotion if you're today's Dictator
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
    const meName = state.currentUser.name;
    document.getElementById("nudge-msg-prefix").textContent =
      `${meName} nudged you:`;
    document.getElementById("kudos-msg-prefix").textContent =
      `${meName} gave kudos:`;
    const nudgeInput = document.getElementById("nudge-msg-input");
    const kudosInput = document.getElementById("kudos-msg-input");
    nudgeInput.placeholder = NUDGE_DEFAULT_BODY;
    kudosInput.placeholder = KUDOS_DEFAULT_BODY;
    nudgeInput.value = localStorage.getItem("np_nudge_msg") || "";
    kudosInput.value = localStorage.getItem("np_kudos_msg") || "";
    renderColorPicker();
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
    .getElementById("nudge-msg-input")
    ?.addEventListener("input", (e) => setNudgeBody(false, e.target.value));
  document
    .getElementById("kudos-msg-input")
    ?.addEventListener("input", (e) => setNudgeBody(true, e.target.value));
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
    if (document.visibilityState !== "visible") return;
    syncTimezoneOffset();
    recordUsageOpen(); // usage analytics: a re-focus may be a new session
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

  document.getElementById("btn-unlock-sound").addEventListener("click", () => {
    playAlanBoing();
    const btn = document.getElementById("btn-unlock-sound");
    btn.textContent = "✅ Sounds Enabled";
    btn.disabled = true;
  });

  document
    .getElementById("btn-reset-squad-glory")
    .addEventListener("click", () => {
      localStorage.removeItem("np_group_glory");
      state.groupCelebratedToday = false;
      showToast(
        "Squad glory reset — will trigger again next completion",
        "success",
      );
    });

  document.getElementById("btn-toggle-glory").addEventListener("click", () => {
    const btn = document.getElementById("btn-toggle-glory");
    const active = document.body.classList.contains("group-glory-day");
    if (active) {
      document.getElementById("app").classList.remove("group-glory-day");
      document.body.classList.remove("group-glory-day");
      document.querySelector(".glory-today-alan")?.remove();
      document.getElementById("glory-alan-float")?.remove();
      btn.textContent = "Preview Glory Day";
    } else {
      applyGloryAmbient();
      btn.textContent = "Disable Glory Day";
    }
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
  // Clean up stale daily rep counts from previous days (uses device local time)
  (function pruneOldCounts() {
    const today = getTodayStr();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith("np_count_") && !key.endsWith(today)) {
        localStorage.removeItem(key);
      }
    }
  })();
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
let _lastUtcDay = getUTCTodayStr();
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

  // Dictator feature: the decree doc is keyed by UTC date, which can roll over
  // at a different moment than the local day. Re-point the listener and, if the
  // logged-in user is the new day's Dictator, offer the appointment popup.
  const newUtcDay = getUTCTodayStr();
  if (newUtcDay !== _lastUtcDay) {
    _lastUtcDay = newUtcDay;
    subscribeDecree();
    refreshReignPlebs(); // reign may have extended into the new day, or reset
    if (state.currentUser) {
      renderCurrentView();
      maybeShowDictatorPopup();
    }
  }
}, 60000);

document.addEventListener("DOMContentLoaded", init);
