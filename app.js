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
  getDocs,
  setDoc,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  getMessaging,
  getToken,
  onMessage,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js";

// ============================================================
// CONFIG — Replace with your values after setup
// ============================================================
const CONFIG = {
  // Firebase config (from Firebase Console > Project Settings)
  FIREBASE: {
    apiKey: "AIzaSyA0z60T4sRGFLX6pNVSD2Z5ZuSGAP9dGns",
    authDomain: "net-positive-workout.firebaseapp.com",
    projectId: "net-positive-workout",
    storageBucket: "net-positive-workout.firebasestorage.app",
    messagingSenderId: "944399851248",
    appId: "1:944399851248:web:8cb52b6f773c6ac43f2c35",
    measurementId: "G-37MKXHVX73",
  },

  // VAPID key from Firebase Console > Cloud Messaging > Web Push certificates
  VAPID_KEY:
    "BN3aNe06Yk-B-1d_L0FWhu7gTWElTpE-BmLQqHXploEx2gQBzx8prUYdF0qlWa705--VGbC5Zoz90NKO6ht9oT0",

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
};

// ============================================================
// UTILITIES
// ============================================================

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

function calcFinesForPerson(name, dates) {
  let total = 0;
  for (const date of dates) {
    if (date === state.todayStr) continue;
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
  const allDates = [...new Set(state.completions.map((c) => c.date))].sort();
  return calcFinesForPerson(name, allDates);
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

// ============================================================
// FIRESTORE DATA LAYER
// ============================================================

async function loadData() {
  if (!db) throw new Error("Firebase not initialized");
  try {
    const [participantsSnap, completionsSnap] = await Promise.all([
      getDocs(collection(db, "participants")),
      getDocs(collection(db, "completions")),
    ]);
    state.participants = participantsSnap.docs.map((d) => d.data());
    state.completions = completionsSnap.docs.map((d) => d.data());
  } catch (err) {
    showToast("Failed to load data. Check your connection.", "error");
    throw err;
  }
}

async function saveCompletion(personName, exerciseId, completed) {
  const item = {
    date: state.todayStr,
    person: personName,
    exercise: exerciseId,
    completed,
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

    // Check if all exercises now done — send notification
    if (completed && isWorkoutComplete(personName, state.todayStr)) {
      sendCompletionNotification(personName);
    }
  } catch (err) {
    state.offlineQueue.push({ docId, item });
    saveOfflineQueue();
    showToast("Saved offline — will sync when connected", "info");
  }
}

async function addParticipant(name, pin) {
  if (!db) throw new Error("Firebase not initialized");
  const colorIndex = state.participants.length % COLORS.length;
  const participant = { name, pin, colorIndex };
  await setDoc(doc(db, "participants", name), participant);
  state.participants.push(participant);
  return participant;
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
        message: `💪 ${personName} just completed today's workout!`,
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
  state.offlineQueue = [];
  saveOfflineQueue();
  for (const { docId, item } of queue) {
    try {
      await setDoc(doc(db, "completions", docId), item);
    } catch {
      state.offlineQueue.push({ docId, item });
    }
  }
  if (state.offlineQueue.length) saveOfflineQueue();
  else showToast("Offline changes synced!", "success");
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
      <div class="participant-avatar" style="background:${color};">${getInitials(p.name)}</div>
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
    saveCurrentUser(pinTarget);
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

  state.participants.forEach((participant) => {
    const isMe =
      state.currentUser && state.currentUser.name === participant.name;
    const fine = calcFinesForPersonAllTime(participant.name);
    const completedToday = getCompletedExercisesForDay(
      participant.name,
      state.todayStr,
    );
    const allDone = isWorkoutComplete(participant.name, state.todayStr);
    const color = getParticipantColor(participant);
    const initials = getInitials(participant.name);

    const card = document.createElement("div");
    card.className = `workout-card${isMe ? " is-me" : ""}${allDone ? " completed-all" : ""}`;
    card.id = `card-${participant.name.replace(/\s+/g, "-")}`;

    const fineDisplay = fine === 0 ? "$0" : `-$${fine}`;
    const fineClass = fine === 0 ? "zero" : "";

    const exercisesHTML = CONFIG.EXERCISES.map((ex) => {
      const done = completedToday.includes(ex.id);
      return `
        <div class="exercise-item">
          <button class="exercise-check${done ? " checked" : ""}"
                  data-person="${participant.name}" data-exercise="${ex.id}"
                  ${!isMe ? "disabled" : ""}
                  aria-label="${done ? "Uncheck" : "Check"} ${ex.name}"
                  title="${isMe ? "" : "Log in as " + participant.name + " to check this"}">
          </button>
          <div class="exercise-info">
            <div class="exercise-name">${ex.name}</div>
            <div class="exercise-target">${ex.target}</div>
          </div>
          <span class="exercise-emoji">${ex.emoji}</span>
        </div>
      `;
    }).join("");

    const statusText = allDone
      ? "🎉 All done!"
      : `${completedToday.length}/${CONFIG.EXERCISES.length} completed`;

    card.innerHTML = `
      <div class="card-header">
        <div class="card-avatar" style="background:${color};">${initials}</div>
        <div class="card-info">
          <div class="card-name">${participant.name}${isMe ? ' <span style="font-size:0.7rem;font-weight:600;color:var(--accent);">(you)</span>' : ""}</div>
          <div class="card-status">${statusText}</div>
        </div>
        <div class="card-fine">
          <div class="fine-amount ${fineClass}">${fineDisplay}</div>
          <div class="fine-label">All-time fines</div>
        </div>
      </div>
      <div class="exercise-list">${exercisesHTML}</div>
      ${allDone ? '<div class="completion-banner">🎉 Workout Complete!</div>' : ""}
    `;

    if (isMe) {
      card.querySelectorAll(".exercise-check").forEach((btn) => {
        btn.addEventListener("click", handleExerciseCheck);
      });
    }

    container.appendChild(card);
  });
}

async function handleExerciseCheck(e) {
  const btn = e.currentTarget;
  const personName = btn.dataset.person;
  const exerciseId = btn.dataset.exercise;
  if (personName !== state.currentUser?.name) return;

  const wasChecked = btn.classList.contains("checked");
  const nowChecked = !wasChecked;
  btn.classList.toggle("checked", nowChecked);

  const cardEl = btn.closest(".workout-card");
  const allChecked = [...cardEl.querySelectorAll(".exercise-check")].every(
    (b) => b.classList.contains("checked"),
  );

  const checkedCount = [...cardEl.querySelectorAll(".exercise-check.checked")].length;

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
    cardEl.querySelector(".card-status").textContent = `${checkedCount}/${CONFIG.EXERCISES.length} completed`;
  }

  try {
    await saveCompletion(personName, exerciseId, nowChecked);
  } catch {
    btn.classList.toggle("checked", wasChecked);
    showToast("Failed to save. Try again.", "error");
  }
}

// ============================================================
// RENDER: LEADERBOARD
// ============================================================

function renderLeaderboard() {
  const container = document.getElementById("leaderboard-container");
  container.innerHTML = "";

  const allDates = [...new Set(state.completions.map((c) => c.date))].sort();

  const data = state.participants.map((p) => {
    const totalFines = calcFinesForPersonAllTime(p.name);
    const totalDays = allDates.filter((d) => d !== state.todayStr);
    const totalCompletions = totalDays.filter((d) =>
      isWorkoutComplete(p.name, d),
    ).length;

    let streak = 0;
    const days = getLast7Days()
      .filter((d) => d !== state.todayStr)
      .reverse();
    for (const d of days) {
      if (isWorkoutComplete(p.name, d)) streak++;
      else break;
    }

    return { participant: p, totalFines, totalCompletions, streak };
  });

  data.sort((a, b) => {
    if (a.totalFines !== b.totalFines) return a.totalFines - b.totalFines;
    return b.totalCompletions - a.totalCompletions;
  });

  const rankEmojis = ["🥇", "🥈", "🥉"];
  const rankClasses = ["gold", "silver", "bronze"];
  const allDaysExceptToday = allDates.filter((d) => d !== state.todayStr);

  data.forEach((entry, i) => {
    const { participant, totalFines, totalCompletions, streak } = entry;
    const color = getParticipantColor(participant);
    const fineDisplay = totalFines === 0 ? "$0" : `-$${totalFines}`;
    const fineClass = totalFines === 0 ? "zero" : "";
    const rate =
      allDaysExceptToday.length > 0
        ? Math.round((totalCompletions / allDaysExceptToday.length) * 100)
        : 0;

    const item = document.createElement("div");
    item.className = "leaderboard-item";
    item.innerHTML = `
      <div class="rank-badge ${i < 3 ? rankClasses[i] : ""}">${i < 3 ? rankEmojis[i] : i + 1}</div>
      <div class="leaderboard-avatar" style="background:${color};">${getInitials(participant.name)}</div>
      <div class="leaderboard-info">
        <div class="leaderboard-name">${participant.name}</div>
        <div class="leaderboard-stats">
          <span class="stat-pill completions">✅ ${totalCompletions} days</span>
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

function renderHistory() {
  const container = document.getElementById("history-container");
  container.innerHTML = "";
  const days = getLast7Days();

  state.participants.forEach((participant) => {
    const color = getParticipantColor(participant);
    const section = document.createElement("div");
    section.className = "history-person";

    let daysHTML = "";
    for (let i = days.length - 1; i >= 0; i--) {
      const date = days[i];
      const isToday = date === state.todayStr;
      const done = getCompletedExercisesForDay(participant.name, date);

      const exBadges = CONFIG.EXERCISES.map((ex) => {
        const isDone = done.includes(ex.id);
        if (isToday && !isDone)
          return `<span class="history-ex-badge" style="background:rgba(90,90,128,0.15);color:var(--text-muted);">${ex.emoji} —</span>`;
        return `<span class="history-ex-badge ${isDone ? "done" : "missed"}">${ex.emoji} ${isDone ? "✓" : "✗"}</span>`;
      }).join("");

      let dayFine = 0;
      if (!isToday) {
        const missed = CONFIG.EXERCISES.filter(
          (ex) => !done.includes(ex.id),
        ).length;
        dayFine =
          missed === CONFIG.EXERCISES.length
            ? CONFIG.FINE_ALL_MISSED
            : missed * CONFIG.FINE_PER_EXERCISE;
      }

      daysHTML += `
        <div class="history-day">
          <div class="history-date">${formatDateLabel(date)}</div>
          <div class="history-exercises">${exBadges}</div>
          ${
            !isToday
              ? `<div class="history-fine-day ${dayFine > 0 ? "" : "zero"}">${dayFine > 0 ? `-$${dayFine}` : "$0"}</div>`
              : `<div class="history-fine-day zero" style="font-size:0.7rem;">today</div>`
          }
        </div>
      `;
    }

    section.innerHTML = `
      <div class="history-person-header">
        <div class="history-avatar" style="background:${color};">${getInitials(participant.name)}</div>
        <div><div class="history-name">${participant.name}</div></div>
      </div>
      <div class="history-days">${daysHTML}</div>
    `;
    container.appendChild(section);
  });
}

// ============================================================
// RENDER: ADMIN
// ============================================================

function renderAdmin() {
  const totalFines = state.participants.reduce(
    (sum, p) => sum + calcFinesForPersonAllTime(p.name),
    0,
  );
  document.getElementById("total-pot-amount").textContent = `$${totalFines}`;

  const list = document.getElementById("admin-participants-list");
  list.innerHTML = "";
  state.participants.forEach((p) => {
    const color = getParticipantColor(p);
    const fine = calcFinesForPersonAllTime(p.name);
    const row = document.createElement("div");
    row.className = "participant-admin-row";
    row.innerHTML = `
      <div class="admin-avatar" style="background:${color};">${getInitials(p.name)}</div>
      <span class="admin-name">${p.name}</span>
      <span style="font-size:0.8rem;color:var(--danger);font-weight:700;font-family:var(--font-mono);">
        ${fine > 0 ? `-$${fine}` : "$0"}
      </span>
      <button class="btn-danger" style="padding:6px 10px;font-size:0.75rem;" data-remove="${p.name}">Remove</button>
    `;
    row
      .querySelector("[data-remove]")
      .addEventListener("click", () => confirmRemoveParticipant(p.name));
    list.appendChild(row);
  });

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
  const initials = getInitials(state.currentUser.name);
  document.getElementById("header-avatar").style.background = color;
  document.getElementById("header-avatar").textContent = initials;
  document.getElementById("header-name").textContent = state.currentUser.name;
}

// ============================================================
// NAVIGATION
// ============================================================

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

function showApp() {
  showScreen("app");
  renderHeader();
  showView("today");
  checkIOSInstallPrompt();
  initNotifications();
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

  document.getElementById("btn-switch-user").addEventListener("click", () => {
    clearCurrentUser();
    showScreen("auth");
    renderAuthScreen();
    showAuthStep("select");
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
    const p = await addParticipant(name, pin);
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
  loadCurrentUser();
  updateOnlineStatus();

  const urlParams = new URLSearchParams(window.location.search);
  const startView = urlParams.get("view");

  try {
    await loadData();
  } catch {
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

// Auto-refresh every 2 minutes when visible
let refreshInterval = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(refreshInterval);
  } else {
    if (!document.getElementById("app").classList.contains("hidden")) {
      loadData()
        .then(() => {
          const v = document.querySelector(".nav-item.active")?.dataset.view;
          if (v) showView(v);
        })
        .catch(() => {});
    }
    refreshInterval = setInterval(() => {
      if (!document.getElementById("app").classList.contains("hidden")) {
        loadData()
          .then(() => {
            const v = document.querySelector(".nav-item.active")?.dataset.view;
            if (v) showView(v);
          })
          .catch(() => {});
      }
    }, 120000);
  }
});

// Day rollover check
setInterval(() => {
  const newDay = getTodayStr();
  if (newDay !== state.todayStr) {
    state.todayStr = newDay;
    const v = document.querySelector(".nav-item.active")?.dataset.view;
    loadData()
      .then(() => {
        if (v) showView(v);
      })
      .catch(() => {});
  }
}, 60000);

document.addEventListener("DOMContentLoaded", init);
