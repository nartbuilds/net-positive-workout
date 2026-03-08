# Net Positive Workout 💪

A Progressive Web App (PWA) for daily workout accountability among friends.

**Track:** 100 Squats · 50 Push-ups · 5 Min Plank — every day.
**Miss one?** Pay up. Every missed exercise = $10. Miss all 3 = $50 flat.

---

## Table of Contents

1. [Quick Overview](#quick-overview)
2. [Google Sheets Setup](#1-google-sheets-setup)
3. [Google Apps Script Deployment](#2-google-apps-script-deployment)
4. [Firebase Setup (Push Notifications)](#3-firebase-setup-push-notifications)
5. [Frontend Configuration](#4-frontend-configuration)
6. [Hosting on Netlify or Vercel](#5-hosting-on-netlify-or-vercel)
7. [Installing as a PWA](#6-installing-as-a-pwa)
8. [First Launch & Adding Participants](#7-first-launch--adding-participants)
9. [Adding Reminder Notifications Later](#8-adding-reminder-notifications-later)
10. [File Structure](#file-structure)
11. [FAQ / Troubleshooting](#faq--troubleshooting)

---

## Quick Overview

| Component | Technology | Cost |
|-----------|-----------|------|
| Frontend | Vanilla HTML/CSS/JS PWA | Free |
| Database | Google Sheets | Free |
| Backend API | Google Apps Script | Free |
| Push Notifications | Firebase Cloud Messaging | Free |
| Hosting | Netlify or Vercel | Free |

---

## 1. Google Sheets Setup

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet.
2. Name it something like **"Net Positive Workout"**.
3. The Apps Script will automatically create the required tabs on first use:
   - **`completions`** — date, person, exercise, completed
   - **`participants`** — name, pin, colorIndex
   - **`tokens`** — FCM push notification tokens
4. Keep note of the spreadsheet URL — you'll need to open it in Apps Script next.

> **Tip:** You can also manually create the three tabs now. The script will add headers automatically when first run.

---

## 2. Google Apps Script Deployment

### 2a. Open Apps Script

1. In your Google Sheet, click **Extensions → Apps Script**.
2. Delete any existing code in `Code.gs`.
3. Paste the entire contents of `Code.gs` from this project.

### 2b. Configure the FCM Server Key (optional — do this after Firebase setup)

Find this line near the top of `Code.gs`:

```javascript
const FCM_SERVER_KEY = 'YOUR_FCM_SERVER_KEY_HERE';
```

Replace it with your Firebase Cloud Messaging **Server Key** (see Firebase setup below).

### 2c. Test the Setup

1. In the Apps Script editor, select the function **`testSetup`** from the dropdown.
2. Click **Run**.
3. Check the **Execution Log** — you should see "✅ All sheets created/verified."

### 2d. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear ⚙️ next to "Select type" and choose **Web app**.
3. Set the following:
   - **Description:** `Net Positive API v1`
   - **Execute as:** `Me` (your Google account)
   - **Who has access:** `Anyone`
4. Click **Deploy**.
5. Copy the **Web app URL** — it looks like:
   ```
   https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec
   ```
6. Authorize the script when prompted (click "Advanced → Go to Net Positive (unsafe)" if needed).

> **Important:** Every time you edit `Code.gs`, you must create a **new deployment** (or update the existing one) for changes to take effect. The `/exec` URL stays the same.

---

## 3. Firebase Setup (Push Notifications)

> **Skip this section if you don't want push notifications.** The app works fine without them.

### 3a. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com).
2. Click **Add project** → name it (e.g., "net-positive-workout") → Continue.
3. Disable Google Analytics (optional) → **Create project**.

### 3b. Register a Web App

1. In the Firebase console, click the **Web** icon (`</>`).
2. Register app name: "Net Positive PWA".
3. **Check** "Also set up Firebase Hosting" — **No**, skip that (we use Netlify/Vercel).
4. Click **Register app**.
5. Copy the `firebaseConfig` object — you'll need it next.

### 3c. Enable Cloud Messaging

1. In Firebase Console, go to **Project Settings → Cloud Messaging**.
2. Under **Web Push certificates**, click **Generate key pair**.
3. Copy the **VAPID key** shown.
4. Scroll up to **Cloud Messaging API (Legacy)** — click the 3-dot menu and **Enable** it.
5. Copy the **Server key** (starts with `AAAA...`).

### 3d. Update Your Configuration

Open `Code.gs` and replace:
```javascript
const FCM_SERVER_KEY = 'YOUR_FCM_SERVER_KEY_HERE';
```

Open `app.js` and replace the `CONFIG` block:
```javascript
const CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec',

  FIREBASE: {
    apiKey: 'YOUR_FIREBASE_API_KEY',
    authDomain: 'your-project.firebaseapp.com',
    projectId: 'your-project-id',
    storageBucket: 'your-project.appspot.com',
    messagingSenderId: 'YOUR_SENDER_ID',
    appId: 'YOUR_APP_ID',
  },

  VAPID_KEY: 'YOUR_VAPID_KEY_HERE',
  // ... rest stays the same
};
```

---

## 4. Frontend Configuration

1. Open `app.js` in a text editor.
2. Find the `CONFIG` object at the top (around line 10).
3. Fill in:

| Field | Value |
|-------|-------|
| `SCRIPT_URL` | Your Apps Script Web App URL |
| `FIREBASE.apiKey` | From Firebase config |
| `FIREBASE.authDomain` | From Firebase config |
| `FIREBASE.projectId` | From Firebase config |
| `FIREBASE.storageBucket` | From Firebase config |
| `FIREBASE.messagingSenderId` | From Firebase config |
| `FIREBASE.appId` | From Firebase config |
| `VAPID_KEY` | From Firebase Cloud Messaging settings |

---

## 5. Hosting on Netlify or Vercel

Both are free and work great for static PWAs.

### Option A: Netlify (Recommended)

1. Create a free account at [netlify.com](https://netlify.com).
2. **Drag and drop** the project folder onto the Netlify dashboard, **or**:
3. Connect your GitHub/GitLab repo and auto-deploy on push.

**Manual deploy:**
```bash
# Install Netlify CLI (optional)
npm install -g netlify-cli
netlify deploy --prod --dir .
```

After deploy, Netlify gives you a URL like `https://your-app.netlify.app`.

**Important — HTTPS is required for:**
- Service workers (PWA install)
- Push notifications
- Netlify and Vercel both provide HTTPS by default ✅

### Option B: Vercel

1. Create account at [vercel.com](https://vercel.com).
2. Install CLI: `npm install -g vercel`
3. From project directory: `vercel --prod`

Or use the web interface to import from GitHub.

### Custom Domain (Optional)

Both Netlify and Vercel let you add a custom domain for free.
Update your manifest's `start_url` if you use a custom domain.

---

## 6. Installing as a PWA

### Android (Chrome / Edge)

1. Open the app in Chrome on Android.
2. Tap the 3-dot menu → **Add to Home screen**.
3. Tap **Add** to confirm.
4. The app icon appears on your home screen and opens full-screen.

### iPhone / iPad (Safari)

> Push notifications require the app to be installed as a PWA on iOS 16.4+.

1. Open the app in **Safari** (must be Safari, not Chrome).
2. Tap the **Share button** (box with arrow pointing up).
3. Scroll down and tap **"Add to Home Screen"**.
4. Tap **Add** in the top-right corner.
5. Open the app from your home screen.

**A banner inside the app will remind iOS users to install it.**

---

## 7. First Launch & Adding Participants

1. Open the app — you'll see a **Welcome screen** since no participants exist yet.
2. Enter your name and a 4-digit PIN.
3. Tap **Create Account 🚀**.
4. You're logged in! Others can join via the **Admin** tab → **Add Participant**.
5. Share the app URL with everyone in the group.
6. Each person installs it and enters their name + PIN.

**PIN notes:**
- PINs are stored in Google Sheets (trust-based system among friends).
- A correct PIN stores your session in localStorage — you won't need to re-enter it each visit.
- Tap **Switch** in the top-right to log out (useful on shared devices).

---

## 8. Adding Reminder Notifications Later

The `sendDailyReminder()` function in `Code.gs` is already implemented and ready to activate.

### To enable morning reminders:

1. Open the Apps Script editor.
2. Click the **clock icon** (Triggers) in the left sidebar.
3. Click **+ Add Trigger**.
4. Configure:
   - Function: `sendDailyReminder`
   - Event source: `Time-driven`
   - Type of time: `Day timer`
   - Time: `8am to 9am` (or your preferred time)
5. Click **Save**.

The function will send a push notification to all registered devices every morning:
> "🏋️ Time to crush today's workout! 100 squats, 50 push-ups, 5 min plank."

### To customize the reminder message:

Edit the `sendDailyReminder()` function in `Code.gs`:
```javascript
const message = "Your custom message here";
```

Then redeploy the script (Deploy → Manage deployments → Edit → New version → Deploy).

### To upgrade to FCM HTTP v1 API (future-proofing):

Google will eventually deprecate the legacy FCM API. To upgrade:

1. In Firebase Console → **Project Settings → Service Accounts**.
2. Generate a new private key (downloads a JSON file).
3. Add the JSON to Apps Script as a Script Property.
4. Replace `sendFCMBatch()` in `Code.gs` with the v1 API call:
   ```
   POST https://fcm.googleapis.com/v1/projects/YOUR_PROJECT_ID/messages:send
   ```
   With OAuth2 authentication using the service account.

The rest of the code (token storage, notification logic) stays the same.

---

## File Structure

```
net-positive-workout/
├── index.html          # Main PWA shell
├── styles.css          # All styling (dark theme, mobile-first)
├── app.js              # Core app logic (auth, tracking, fines, leaderboard)
├── sw.js               # Service worker (offline, push notification handler)
├── manifest.json       # PWA manifest (installability, icons)
├── Code.gs             # Google Apps Script backend
├── README.md           # This file
└── icons/              # PWA icons (you need to add these)
    ├── icon-72.png
    ├── icon-96.png
    ├── icon-128.png
    ├── icon-144.png
    ├── icon-152.png
    ├── icon-192.png
    ├── icon-384.png
    └── icon-512.png
```

### Generating Icons

You need to create PNG icons for the PWA. Use any of these free tools:

- [PWA Asset Generator](https://www.npmjs.com/package/pwa-asset-generator): `npx pwa-asset-generator logo.png ./icons`
- [RealFaviconGenerator](https://realfavicongenerator.net) — upload a square image
- [Maskable.app](https://maskable.app) — check your icons look good on Android

Start with a 512×512 PNG with a gym/fitness theme and generate all sizes.

---

## FAQ / Troubleshooting

**Q: The app shows "Failed to load data" on first open.**
A: Make sure your Apps Script is deployed and the `SCRIPT_URL` in `app.js` is correct. The URL must end with `/exec`.

**Q: CORS errors in the console.**
A: Apps Script doesn't support custom CORS headers. Make sure the script is deployed with "Anyone" access and you're using the correct `/exec` URL (not `/dev`).

**Q: Push notifications aren't working on iPhone.**
A: iOS 16.4+ is required, and the app **must be installed via "Add to Home Screen"** in Safari. Notifications don't work in the browser tab on iOS.

**Q: I need to update the Apps Script code.**
A: After editing `Code.gs`, go to **Deploy → Manage deployments**, click the pencil ✏️, select **New version**, add a description, and click **Deploy**. Your URL stays the same.

**Q: Can I add more exercises?**
A: Yes! Edit the `CONFIG.EXERCISES` array in `app.js`:
```javascript
EXERCISES: [
  { id: 'squats',  name: '100 Squats',  emoji: '🦵', target: '100 reps' },
  { id: 'pushups', name: '50 Push-ups', emoji: '💪', target: '50 reps' },
  { id: 'plank',   name: '5 Min Plank', emoji: '🧘', target: '5 minutes' },
  // Add more here...
],
```
The fine system will automatically scale.

**Q: Can I change the fine amounts?**
A: Yes, edit in `app.js`:
```javascript
FINE_PER_EXERCISE: 10,  // $ per missed exercise
FINE_ALL_MISSED:   50,  // $ flat if all exercises missed
```

**Q: How do I reset everyone's fines?**
A: Clear the `completions` tab in Google Sheets (keep the header row). This resets all history and fines.

**Q: The leaderboard sorts by fewest fines. What if fines are tied?**
A: Ties are broken by total number of complete workout days (more = better rank).

**Q: Can multiple people use the app simultaneously?**
A: Yes. The app polls for fresh data every 2 minutes when visible. When someone checks an exercise, it saves immediately to Google Sheets.

---

## Contributing

This is a personal tool — feel free to fork and adapt it for your group!

---

*Built with ❤️ for fitness accountability*
