/**
 * Net Positive Workout — Main App
 * Vanilla JS PWA for daily workout accountability
 */

"use strict";

// ============================================================
// CONFIG — Replace with your values after setup
// ============================================================
const CONFIG = {
  // Proxied through Netlify to avoid CORS — see netlify.toml
  SCRIPT_URL: "/api",

  // Firebase config (from Firebase Console > Project Settings)
  FIREBASE: {
    apiKey: "YOUR_FIREBASE_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID",
  },

  // VAPID key from Firebase Console > Cloud Messaging > Web Push certificates
  VAPID_KEY: "YOUR_VAPID_KEY_HERE",

  // Exercises each person must complete daily
  EXERCISES: [
    { id: "squats", name: "100 Squats", emoji: "🦵", target: "100 reps" },
    { id: "pushups", name: "50 Push-ups", emoji: "💪", target: "50 reps" },
    { id: "plank", name: "5 Min Plank", emoji: "🧘", target: "5 minutes" },
  ],

  // Fine amounts
  FINE_PER_EXERCISE: 10,
  FINE_ALL_MISSED: 50, // flat rate if all 3 missed

  // History days
  HISTORY_DAYS: 7,
};

// Participant color palette (CSS variables defined in styles.css)
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
  participants: [], // [{name, pin, colorIndex}]
  completions: [], // [{date, person, exercise, completed}]
  currentUser: null, // {name, colorIndex}
  todayStr: getTodayStr(),
  loading: true,
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
    if (date === state.todayStr) continue; // today not finalized yet
    const dayCompletions = state.completions.filter(
      (c) => c.date === date && c.person === name,
    );
    const doneExercises = dayCompletions
      .filter((c) => c.completed)
      .map((c) => c.exercise);
    const missedCount = CONFIG.EXERCISES.filter(
      (ex) => !doneExercises.includes(ex.id),
    ).length;
    if (missedCount === CONFIG.EXERCISES.length) {
      total += CONFIG.FINE_ALL_MISSED;
    } else {
      total += missedCount * CONFIG.FINE_PER_EXERCISE;
    }
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
// API
// ============================================================

async function apiRequest(action, params = {}) {
  // All requests use GET with URL params — Apps Script doesn't support CORS preflight
  // (OPTIONS), so POST with custom headers is always blocked. Simple GET requests
  // never trigger preflight and work reliably from any origin.
  const url = new URL(CONFIG.SCRIPT_URL);
  url.searchParams.set("action", action);

  const data = params.data || {};
  Object.entries(data).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  try {
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error(`[API] ${action} failed:`, err.message);
    throw err;
  }
}

async function loadData() {
  try {
    const [participantsRes, completionsRes] = await Promise.all([
      apiRequest("getParticipants"),
      apiRequest("getCompletions"),
    ]);
    state.participants = participantsRes.data || [];
    state.completions = completionsRes.data || [];
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

  // Optimistic update
  const existing = state.completions.findIndex(
    (c) =>
      c.date === item.date &&
      c.person === item.person &&
      c.exercise === item.exercise,
  );
  if (existing >= 0) {
    state.completions[existing].completed = completed;
  } else {
    state.completions.push(item);
  }

  try {
    const res = await apiRequest("setCompletion", { data: item });
    if (res.notifyAll && res.message) {
      showToast(res.message, "success", 4000);
    }
  } catch (err) {
    // Queue for background sync
    state.offlineQueue.push(item);
    saveOfflineQueue();
    showToast("Saved offline — will sync when connected", "info");
  }
}

async function addParticipant(name, pin) {
  const colorIndex = state.participants.length % COLORS.length;
  const participant = { name, pin, colorIndex };
  const res = await apiRequest("addParticipant", { data: participant });
  if (res.success) {
    state.participants.push(participant);
    return participant;
  }
  throw new Error(res.error || "Failed to add participant");
}

async function removeParticipant(name) {
  const res = await apiRequest("removeParticipant", { data: { name } });
  if (res.success) {
    state.participants = state.participants.filter((p) => p.name !== name);
    return true;
  }
  throw new Error(res.error || "Failed to remove participant");
}

async function registerFCMToken(token) {
  try {
    await apiRequest("registerToken", {
      data: {
        token,
        person: state.currentUser?.name || "unknown",
        device: navigator.userAgent.slice(0, 50),
      },
    });
  } catch (err) {
    console.warn("[FCM] Token registration failed:", err.message);
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
  if (!state.offlineQueue.length) return;
  const queue = [...state.offlineQueue];
  state.offlineQueue = [];
  saveOfflineQueue();

  for (const item of queue) {
    try {
      await apiRequest("setCompletion", { method: "POST", data: item });
    } catch {
      state.offlineQueue.push(item);
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
// RENDER HELPERS
// ============================================================

function avatarHTML(participant, size = 44) {
  const color = getParticipantColor(participant);
  const initials = getInitials(participant.name);
  return `<div class="card-avatar" style="width:${size}px;height:${size}px;background:${color};">${initials}</div>`;
}

// ============================================================
// RENDER: AUTH SCREEN
// ============================================================

function renderAuthScreen() {
  const grid = document.getElementById("auth-participant-grid");
  grid.innerHTML = "";

  state.participants.forEach((p, i) => {
    const color = getParticipantColor(p);
    const initials = getInitials(p.name);
    const btn = document.createElement("button");
    btn.className = "participant-btn";
    btn.dataset.index = i;
    btn.innerHTML = `
      <div class="participant-avatar" style="background:${color};">${initials}</div>
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
  if (pinBuffer.length === 4) {
    setTimeout(verifyPIN, 100);
  }
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
    // Shake animation
    const dotsEl = document.getElementById("pin-dots");
    dotsEl.style.animation = "none";
    requestAnimationFrame(() => {
      dotsEl.style.animation = "";
      dotsEl.style.transition = "transform 0.1s";
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
    });
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

  // Update date label
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

    const fineClass = fine === 0 ? "zero" : "";
    const fineDisplay = fine === 0 ? "$0" : `-$${fine}`;

    const exercisesHTML = CONFIG.EXERCISES.map((ex) => {
      const done = completedToday.includes(ex.id);
      const canCheck = isMe;
      return `
        <div class="exercise-item" data-exercise="${ex.id}" data-person="${participant.name}">
          <button class="exercise-check${done ? " checked" : ""}"
                  data-person="${participant.name}" data-exercise="${ex.id}"
                  ${!canCheck ? "disabled" : ""}
                  aria-label="${done ? "Uncheck" : "Check"} ${ex.name}"
                  title="${canCheck ? "" : "Log in as " + participant.name + " to check this"}">
          </button>
          <div class="exercise-info">
            <div class="exercise-name">${ex.name}</div>
            <div class="exercise-target">${ex.target}</div>
          </div>
          <span class="exercise-emoji">${ex.emoji}</span>
        </div>
      `;
    }).join("");

    const completionBanner = allDone
      ? `<div class="completion-banner">🎉 Workout Complete!</div>`
      : "";

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
      ${completionBanner}
    `;

    // Attach check handlers
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

  // Optimistic UI
  btn.classList.toggle("checked", nowChecked);

  // Check if now all complete
  const cardEl = btn.closest(".workout-card");
  const allChecked = [...cardEl.querySelectorAll(".exercise-check")].every(
    (b) => b.classList.contains("checked"),
  );

  if (allChecked && !cardEl.classList.contains("completed-all")) {
    cardEl.classList.add("completed-all", "just-completed");
    cardEl.querySelector(".card-status").textContent = "🎉 All done!";

    // Add completion banner
    if (!cardEl.querySelector(".completion-banner")) {
      const banner = document.createElement("div");
      banner.className = "completion-banner";
      banner.textContent = "🎉 Workout Complete!";
      cardEl.appendChild(banner);
    }

    triggerConfetti(getParticipantColor(state.currentUser));
    setTimeout(() => cardEl.classList.remove("just-completed"), 600);
  } else if (!allChecked && cardEl.classList.contains("completed-all")) {
    cardEl.classList.remove("completed-all");
    const banner = cardEl.querySelector(".completion-banner");
    if (banner) banner.remove();
    cardEl.querySelector(".card-status").textContent = `${
      [...cardEl.querySelectorAll(".exercise-check.checked")].length
    }/${CONFIG.EXERCISES.length} completed`;
  }

  // Save
  try {
    await saveCompletion(personName, exerciseId, nowChecked);
  } catch (err) {
    // Revert on failure
    btn.classList.toggle("checked", wasChecked);
    showToast("Failed to save. Try again.", "error");
  }
}

// ============================================================
// RENDER: LEADERBOARD VIEW
// ============================================================

function renderLeaderboard() {
  const container = document.getElementById("leaderboard-container");
  container.innerHTML = "";

  const last7 = getLast7Days();
  const allDates = [...new Set(state.completions.map((c) => c.date))].sort();

  const data = state.participants.map((p) => {
    const totalFines = calcFinesForPersonAllTime(p.name);

    // Count full completions in last 7 days
    let completions7 = 0;
    let streak = 0;
    let streakActive = true;
    for (let i = 6; i >= 0; i--) {
      const d = getLast7Days()[6 - i];
      if (d === state.todayStr) continue;
      const done = isWorkoutComplete(p.name, d);
      if (done) {
        completions7++;
        if (streakActive) streak++;
      } else {
        if (streakActive) streakActive = false;
      }
    }

    // Total completions ever
    const totalDays = allDates.filter((d) => d !== state.todayStr);
    const totalCompletions = totalDays.filter((d) =>
      isWorkoutComplete(p.name, d),
    ).length;

    return {
      participant: p,
      totalFines,
      completions7,
      streak,
      totalCompletions,
    };
  });

  // Sort by fewest fines, then most completions
  data.sort((a, b) => {
    if (a.totalFines !== b.totalFines) return a.totalFines - b.totalFines;
    return b.totalCompletions - a.totalCompletions;
  });

  const rankEmojis = ["🥇", "🥈", "🥉"];
  const rankClasses = ["gold", "silver", "bronze"];

  data.forEach((entry, i) => {
    const { participant, totalFines, completions7, streak, totalCompletions } =
      entry;
    const color = getParticipantColor(participant);
    const initials = getInitials(participant.name);
    const fineDisplay = totalFines === 0 ? "$0" : `-$${totalFines}`;
    const fineClass = totalFines === 0 ? "zero" : "";

    const rankContent = i < 3 ? rankEmojis[i] : `${i + 1}`;
    const rankClass = i < 3 ? rankClasses[i] : "";

    // Completion rate for progress bar
    const allDaysExceptToday = allDates.filter((d) => d !== state.todayStr);
    const rate =
      allDaysExceptToday.length > 0
        ? Math.round((totalCompletions / allDaysExceptToday.length) * 100)
        : 0;

    const item = document.createElement("div");
    item.className = "leaderboard-item";
    item.innerHTML = `
      <div class="rank-badge ${rankClass}">${rankContent}</div>
      <div class="leaderboard-avatar" style="background:${color};">${initials}</div>
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
// RENDER: HISTORY VIEW
// ============================================================

function renderHistory() {
  const container = document.getElementById("history-container");
  container.innerHTML = "";

  const days = getLast7Days();

  state.participants.forEach((participant) => {
    const color = getParticipantColor(participant);
    const initials = getInitials(participant.name);

    const section = document.createElement("div");
    section.className = "history-person";

    let daysHTML = "";
    for (let i = days.length - 1; i >= 0; i--) {
      const date = days[i];
      const label = formatDateLabel(date);
      const isToday = date === state.todayStr;
      const doneExercises = getCompletedExercisesForDay(participant.name, date);

      const exBadges = CONFIG.EXERCISES.map((ex) => {
        const done = doneExercises.includes(ex.id);
        if (isToday && !done) {
          return `<span class="history-ex-badge" style="background:rgba(90,90,128,0.15);color:var(--text-muted);">${ex.emoji} —</span>`;
        }
        return `<span class="history-ex-badge ${done ? "done" : "missed"}">${ex.emoji} ${done ? "✓" : "✗"}</span>`;
      }).join("");

      // Fine for this day
      let dayFine = 0;
      if (!isToday) {
        const missedCount = CONFIG.EXERCISES.filter(
          (ex) => !doneExercises.includes(ex.id),
        ).length;
        if (missedCount === CONFIG.EXERCISES.length) {
          dayFine = CONFIG.FINE_ALL_MISSED;
        } else {
          dayFine = missedCount * CONFIG.FINE_PER_EXERCISE;
        }
      }
      const fineStr = dayFine > 0 ? `-$${dayFine}` : isToday ? "" : "$0";
      const fineClass = dayFine > 0 ? "" : "zero";

      daysHTML += `
        <div class="history-day">
          <div class="history-date">${label}</div>
          <div class="history-exercises">${exBadges}</div>
          ${!isToday ? `<div class="history-fine-day ${fineClass}">${fineStr}</div>` : '<div class="history-fine-day zero" style="font-size:0.7rem;">today</div>'}
        </div>
      `;
    }

    section.innerHTML = `
      <div class="history-person-header">
        <div class="history-avatar" style="background:${color};">${initials}</div>
        <div>
          <div class="history-name">${participant.name}</div>
        </div>
      </div>
      <div class="history-days">${daysHTML}</div>
    `;

    container.appendChild(section);
  });
}

// ============================================================
// RENDER: ADMIN VIEW
// ============================================================

function renderAdmin() {
  // Total pot
  const totalFines = state.participants.reduce(
    (sum, p) => sum + calcFinesForPersonAllTime(p.name),
    0,
  );
  document.getElementById("total-pot-amount").textContent = `$${totalFines}`;

  // Participants list
  const list = document.getElementById("admin-participants-list");
  list.innerHTML = "";

  state.participants.forEach((p) => {
    const color = getParticipantColor(p);
    const initials = getInitials(p.name);
    const fine = calcFinesForPersonAllTime(p.name);

    const row = document.createElement("div");
    row.className = "participant-admin-row";
    row.innerHTML = `
      <div class="admin-avatar" style="background:${color};">${initials}</div>
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

  // Notification status
  const notifEl = document.getElementById("notif-status-text");
  if ("Notification" in window) {
    const status = Notification.permission;
    notifEl.textContent =
      status === "granted"
        ? "✅ Push notifications are enabled on this device."
        : status === "denied"
          ? "❌ Notifications are blocked. Update your browser settings to enable them."
          : "⚠️ Notifications not yet enabled. Tap below to request permission.";
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

  // Render view on show
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

window.__showToast = showToast;

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
  const count = 50;

  for (let i = 0; i < count; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    const c = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 0.8;
    const duration = 2 + Math.random() * 1.5;
    const size = 6 + Math.random() * 8;
    piece.style.cssText = `
      left:${left}vw;
      background:${c};
      width:${size}px;
      height:${size}px;
      animation-delay:${delay}s;
      animation-duration:${duration}s;
      border-radius:${Math.random() > 0.5 ? "50%" : "2px"};
    `;
    container.appendChild(piece);
    setTimeout(() => piece.remove(), (delay + duration) * 1000 + 100);
  }
}

// ============================================================
// FCM / NOTIFICATIONS
// ============================================================

async function initNotifications() {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;

  // Check if Firebase is configured
  if (CONFIG.FIREBASE.apiKey === "YOUR_FIREBASE_API_KEY") return;

  try {
    await window.__initFirebase(CONFIG.FIREBASE, CONFIG.VAPID_KEY);
  } catch {
    return;
  }

  if (Notification.permission === "granted") {
    await getFCMToken();
  } else if (Notification.permission !== "denied") {
    document.getElementById("notif-banner").classList.remove("hidden");
  }
}

async function requestNotificationPermission() {
  if (!window.__fcmMessaging) return;
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
  if (!window.__fcmMessaging || !window.__fcmVapidKey) return;
  try {
    const { getToken } =
      await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js");
    const sw = await navigator.serviceWorker.ready;
    const token = await getToken(window.__fcmMessaging, {
      vapidKey: window.__fcmVapidKey,
      serviceWorkerRegistration: sw,
    });
    if (token) {
      await registerFCMToken(token);
      console.log("[FCM] Token registered");
    }
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
    const reg = await navigator.serviceWorker.register("/sw.js");
    console.log("[SW] Registered");

    // Listen for sync requests
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "SYNC_COMPLETIONS") {
        flushOfflineQueue();
      }
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
  // PIN keypad
  document.getElementById("pin-keypad").addEventListener("click", (e) => {
    const key = e.target.closest(".pin-key");
    if (!key) return;
    const digit = key.dataset.digit;
    const action = key.dataset.action;
    if (digit !== undefined) handlePinKey(digit);
    else if (action === "back") handlePinBack();
    else if (action === "clear") handlePinClear();
  });

  // Auth back
  document.getElementById("btn-auth-back").addEventListener("click", () => {
    pinBuffer = "";
    pinTarget = null;
    showAuthStep("select");
  });

  // Show add participant from auth
  document
    .getElementById("btn-show-add-from-auth")
    .addEventListener("click", () => {
      clearModal();
      openModal("add-participant-modal");
    });

  // Switch user
  document.getElementById("btn-switch-user").addEventListener("click", () => {
    clearCurrentUser();
    showScreen("auth");
    renderAuthScreen();
    showAuthStep("select");
  });

  // Bottom nav
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  // Setup form
  document
    .getElementById("btn-setup-submit")
    .addEventListener("click", handleSetupSubmit);
  document.getElementById("setup-pin").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSetupSubmit();
  });

  // Add participant modal — open
  document
    .getElementById("btn-show-add-participant")
    .addEventListener("click", () => {
      clearModal();
      openModal("add-participant-modal");
    });

  // Add participant — submit
  document
    .getElementById("btn-add-participant-submit")
    .addEventListener("click", handleAddParticipant);
  document.getElementById("add-pin").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleAddParticipant();
  });

  // Add participant — cancel
  document
    .getElementById("btn-cancel-add")
    .addEventListener("click", () => closeModal("add-participant-modal"));

  // Remove participant — confirm
  document
    .getElementById("btn-confirm-remove")
    .addEventListener("click", handleRemoveParticipant);
  document
    .getElementById("btn-cancel-remove")
    .addEventListener("click", () => closeModal("remove-participant-modal"));

  // Close modals on overlay click
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("open");
    });
  });

  // Notification banner
  document
    .getElementById("btn-enable-notifs")
    .addEventListener("click", requestNotificationPermission);
  document
    .getElementById("btn-admin-notifs")
    .addEventListener("click", requestNotificationPermission);

  // iOS banner close
  document.getElementById("ios-banner-close").addEventListener("click", () => {
    document.getElementById("ios-install-banner").classList.add("hidden");
    localStorage.setItem("np_ios_banner_dismissed", "1");
  });

  // Online/offline
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
  const nameEl = document.getElementById("setup-name");
  const pinEl = document.getElementById("setup-pin");
  const errorEl = document.getElementById("setup-error");

  const name = nameEl.value.trim();
  const pin = pinEl.value.trim();

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
  const errorEl = document.getElementById("add-error");

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
    // If we came from auth, re-render auth grid
    if (
      document.getElementById("auth-screen").classList.contains("hidden") ===
      false
    ) {
      renderAuthScreen();
    }
    // If in app, refresh current view
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

    // If current user removed themselves, log them out
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
  bindEvents();
  registerServiceWorker();
  loadOfflineQueue();
  loadCurrentUser();
  updateOnlineStatus();

  // Handle view param in URL (for PWA shortcuts)
  const urlParams = new URLSearchParams(window.location.search);
  const startView = urlParams.get("view");

  try {
    await loadData();
  } catch {
    // If we can't load data and have no participants, show setup
    if (state.participants.length === 0) {
      showScreen("setup");
      return;
    }
    // If we have cached user, show app with stale data
    if (state.currentUser) {
      showApp();
      if (startView) showView(startView);
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

  // If we have a saved user and they still exist in participants
  if (state.currentUser) {
    const stillExists = state.participants.some(
      (p) => p.name === state.currentUser.name,
    );
    if (stillExists) {
      // Sync color index in case it changed
      const updated = state.participants.find(
        (p) => p.name === state.currentUser.name,
      );
      state.currentUser.colorIndex = updated.colorIndex;
      showApp();
      if (startView) showView(startView);
      return;
    } else {
      clearCurrentUser();
    }
  }

  showScreen("auth");
  renderAuthScreen();
  showAuthStep("select");
}

// Auto-refresh data every 2 minutes when app is visible
let refreshInterval = null;

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(refreshInterval);
  } else {
    // Refresh on coming back to app
    if (!document.getElementById("app").classList.contains("hidden")) {
      loadData()
        .then(() => {
          const activeView =
            document.querySelector(".nav-item.active")?.dataset.view;
          if (activeView) showView(activeView);
        })
        .catch(() => {});
    }
    refreshInterval = setInterval(() => {
      if (!document.getElementById("app").classList.contains("hidden")) {
        loadData()
          .then(() => {
            const activeView =
              document.querySelector(".nav-item.active")?.dataset.view;
            if (activeView) showView(activeView);
          })
          .catch(() => {});
      }
    }, 120000);
  }
});

// Check for day rollover
function checkDayRollover() {
  const newDay = getTodayStr();
  if (newDay !== state.todayStr) {
    state.todayStr = newDay;
    const activeView = document.querySelector(".nav-item.active")?.dataset.view;
    loadData()
      .then(() => {
        if (activeView) showView(activeView);
      })
      .catch(() => {});
  }
}
setInterval(checkDayRollover, 60000);

// Start
document.addEventListener("DOMContentLoaded", init);
