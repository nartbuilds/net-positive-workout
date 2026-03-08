# Net Positive Workout 💪

A Progressive Web App (PWA) for daily workout accountability among friends.

**Track:** 100 Squats · 50 Push-ups · 5 Min Plank — every day.
**Miss one?** Pay up. Every missed exercise = $10. Miss all 3 = $50 flat.

---

## Table of Contents

1. [Quick Overview](#quick-overview)
2. [Firebase Setup](#1-firebase-setup)
3. [Configure the App](#2-configure-the-app)
4. [Netlify Deployment](#3-netlify-deployment)
5. [FCM Push Notifications](#4-fcm-push-notifications)
6. [Installing as a PWA](#5-installing-as-a-pwa)
7. [First Launch & Adding Participants](#6-first-launch--adding-participants)
8. [Adding Reminder Notifications Later](#7-adding-reminder-notifications-later)
9. [File Structure](#file-structure)
10. [FAQ / Troubleshooting](#faq--troubleshooting)

---

## Quick Overview

| Component | Technology | Cost |
|-----------|-----------|------|
| Frontend | Vanilla HTML/CSS/JS PWA (ES modules) | Free |
| Database | Firebase Firestore | Free |
| Push Notifications | Firebase Cloud Messaging (FCM) | Free |
| Notification Relay | Netlify Functions | Free |
| Hosting | Netlify | Free |

---

## 1. Firebase Setup

Everything — database and push notifications — runs through a single Firebase project.

### 1a. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com).
2. Click **Add project** → name it (e.g. "net-positive-workout") → **Continue**.
3. Disable Google Analytics (optional) → **Create project**.

### 1b. Register a Web App

1. On the project overview page, click the **Web icon** (`</>`).
2. Enter app nickname: `Net Positive PWA` → **Register app**.
3. Copy the `firebaseConfig` object shown — you'll need it in the next step.
4. Click **Continue to console**.

### 1c. Create a Firestore Database

1. In the Firebase console sidebar, go to **Build → Firestore Database**.
2. Click **Create database**.
3. Choose **Start in test mode** (allows open reads/writes — fine for a friend group).
4. Select a region close to you → **Enable**.

That's it. Firestore will auto-create collections when the app first writes data.

### 1d. Enable Cloud Messaging (for push notifications)

1. Go to **Project Settings** (gear icon) → **Cloud Messaging** tab.
2. Under **Web Push certificates**, click **Generate key pair**.
3. Copy the **VAPID key** shown.
4. Scroll up — under **Cloud Messaging API (Legacy)**, enable it if not already on.
5. Copy the **Server key** (starts with `AAAA...`). You'll add this to Netlify later.

---

## 2. Configure the App

Open `app.js` and fill in the `CONFIG` block at the top:

```js
const CONFIG = {
  FIREBASE: {
    apiKey: "...",
    authDomain: "your-project.firebaseapp.com",
    projectId: "your-project-id",
    storageBucket: "your-project.appspot.com",
    messagingSenderId: "...",
    appId: "...",
  },

  VAPID_KEY: "your-vapid-key-from-step-1d",

  // Exercises, fines, etc. — edit if you want to customise
  EXERCISES: [
    { id: "squats",  name: "100 Squats",  emoji: "🦵", target: "100 reps" },
    { id: "pushups", name: "50 Push-ups", emoji: "💪", target: "50 reps" },
    { id: "plank",   name: "5 Min Plank", emoji: "🧘", target: "5 minutes" },
  ],
  FINE_PER_EXERCISE: 10,
  FINE_ALL_MISSED: 50,
};
```

---

## 3. Netlify Deployment

### 3a. Deploy the site

1. Create a free account at [netlify.com](https://netlify.com).
2. Click **Add new site → Import an existing project** and connect your GitHub repo.
3. Build settings — leave everything blank (this is a static site with no build step).
4. Click **Deploy site**.

Netlify gives you a URL like `https://your-app.netlify.app`.

> **HTTPS is required** for service workers and push notifications. Netlify provides it automatically.

### 3b. Add the FCM server key as an environment variable

1. In the Netlify dashboard, go to **Site configuration → Environment variables**.
2. Click **Add a variable**:
   - Key: `FCM_SERVER_KEY`
   - Value: your FCM server key from step 1d
3. Click **Save**.
4. Trigger a redeploy: **Deploys → Trigger deploy → Deploy site**.

This key is used by the `netlify/functions/notify.js` serverless function to send push notifications when someone completes their workout. It never touches the client.

### 3c. Local development

Use the Netlify CLI to run everything locally including the serverless function:

```bash
npm install -g netlify-cli
netlify dev
```

Open `http://localhost:8888`. The Firestore connection and notification function both work locally.

---

## 4. FCM Push Notifications

When a participant completes all 3 exercises, every other participant's device receives a push notification: *"💪 Alex just completed today's workout!"*

### How it works

1. Each device registers an FCM token in Firestore (`tokens` collection) on first load.
2. On workout completion, the app reads all other participants' tokens from Firestore.
3. The app calls the Netlify Function (`/.netlify/functions/notify`) with the token list.
4. The function sends the push via FCM's server API using the secret server key.

### iPhone / iOS notes

- iOS 16.4+ is required for push notifications on iPhone.
- The app **must be installed via "Add to Home Screen"** in Safari — notifications do not work in the browser tab on iOS.
- A banner inside the app will remind iOS users to install it.

---

## 5. Installing as a PWA

### Android (Chrome / Edge)

1. Open the app in Chrome on Android.
2. Tap the 3-dot menu → **Add to Home screen** → **Add**.
3. The app opens full-screen from your home screen.

### iPhone / iPad (Safari only)

1. Open the app in **Safari** (not Chrome).
2. Tap the **Share button** (box with arrow pointing up ↑).
3. Scroll down and tap **"Add to Home Screen"**.
4. Tap **Add** in the top-right corner.
5. Launch from your home screen.

---

## 6. First Launch & Adding Participants

1. Open the app — you'll see a **Welcome screen** since no participants exist yet.
2. Enter your name and a 4-digit PIN.
3. Tap **Create Account 🚀**.
4. You're in. Share the app URL with everyone else.
5. Each person opens the link, taps **+ Add new participant**, enters their name and PIN.

**PIN notes:**
- PINs are stored in Firestore (trust-based system — no accounts or email needed).
- A correct PIN saves your session to localStorage so you stay logged in.
- Tap **Switch** in the top-right corner to log out (useful on shared devices).
- Authenticated users can only check off their own exercises.

---

## 7. Adding Reminder Notifications Later

The notification infrastructure is already in place. To add morning reminders:

1. Create a new Netlify scheduled function at `netlify/functions/remind.js`:

```js
// Runs every day at 8am UTC — set schedule in netlify.toml
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

exports.handler = async () => {
  // Initialize admin SDK with service account
  // Read all tokens from Firestore
  // Call FCM send endpoint with reminder message
};
```

2. Add the schedule to `netlify.toml`:

```toml
[functions."remind"]
  schedule = "0 8 * * *"
```

3. Add a Firebase service account JSON as a Netlify environment variable for server-side Firestore access.

The existing token registration, Firestore structure, and `notify.js` function are all designed so this can be wired up without changing anything else.

---

## File Structure

```
net-positive-workout/
├── index.html                  # PWA shell
├── styles.css                  # Dark theme, mobile-first styles
├── app.js                      # Core app logic (ES module, Firestore)
├── sw.js                       # Service worker (offline, push handler)
├── manifest.json               # PWA manifest (installability, icons)
├── netlify.toml                # Netlify functions config
├── netlify/
│   └── functions/
│       └── notify.js           # Serverless function: sends FCM push
├── README.md                   # This file
└── icons/                      # PWA icons (replace placeholders)
    ├── icon-72.png
    ├── icon-96.png
    ├── icon-128.png
    ├── icon-144.png
    ├── icon-152.png
    ├── icon-192.png
    ├── icon-384.png
    └── icon-512.png
```

> **Note:** `Code.gs` is no longer used. The Google Sheets/Apps Script backend has been replaced entirely by Firebase Firestore.

### Generating Real Icons

The `icons/` folder contains placeholder PNGs. Replace them before sharing with your group:

```bash
npx pwa-asset-generator your-logo.png ./icons --background "#6c63ff"
```

Or use [RealFaviconGenerator](https://realfavicongenerator.net) — upload a 512×512 image and download all sizes.

---

## FAQ / Troubleshooting

**Q: The app shows "Firebase not configured" on load.**
A: Open `app.js` and fill in the `CONFIG.FIREBASE` block with your Firebase project values. See step 2 above.

**Q: Firestore permission denied errors.**
A: Make sure your Firestore database was created in **test mode**. In Firebase Console → Firestore → Rules, the rules should allow reads and writes:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

**Q: Push notifications aren't working on iPhone.**
A: iOS 16.4+ is required and the app must be installed via Safari's "Add to Home Screen". Notifications don't work from the browser tab on iOS.

**Q: Push notifications aren't working on Android/desktop.**
A: Check that `FCM_SERVER_KEY` is set in Netlify's environment variables and the site has been redeployed after adding it. Also check that the browser has granted notification permission.

**Q: The notification function isn't being called.**
A: Open browser devtools → Network tab. When you check the final exercise, look for a POST to `/.netlify/functions/notify`. If it's missing, check the browser console for errors.

**Q: Can I change the exercises?**
A: Yes — edit the `CONFIG.EXERCISES` array in `app.js`:
```js
EXERCISES: [
  { id: "squats",   name: "100 Squats",  emoji: "🦵", target: "100 reps" },
  { id: "pushups",  name: "50 Push-ups", emoji: "💪", target: "50 reps" },
  { id: "plank",    name: "5 Min Plank", emoji: "🧘", target: "5 minutes" },
  // add more here...
],
```
The fine system scales automatically.

**Q: Can I change the fine amounts?**
A: Yes — edit in `app.js`:
```js
FINE_PER_EXERCISE: 10,  // $ per missed exercise
FINE_ALL_MISSED:   50,  // $ flat if all exercises missed in a day
```

**Q: How do I reset all history and fines?**
A: In Firebase Console → Firestore → select the `completions` collection → delete all documents.

**Q: Can multiple people use the app at the same time?**
A: Yes. The app refreshes data every 2 minutes when the tab is visible, and immediately on tab focus.

**Q: How do I update the app after changing code?**
A: Push to GitHub — Netlify auto-deploys on every push to your main branch.

---

*Built for fitness accountability among friends.*
