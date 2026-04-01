import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFileSync, readFileSync } from "fs";

// Load .env if FIREBASE_SERVICE_ACCOUNT not already in environment
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  const env = readFileSync(".env", "utf8");
  const match = env.match(/^FIREBASE_SERVICE_ACCOUNT=(.+)$/m);
  if (match) process.env.FIREBASE_SERVICE_ACCOUNT = match[1];
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

console.log("Fetching completions...");
const [snap, participantsSnap] = await Promise.all([
  db.collection("completions").get(),
  db.collection("participants").get(),
]);
const docs = snap.docs.map((d) => d.data());

// Index existing records by date+person+exercise
const existing = {};
for (const c of docs) {
  existing[`${c.date}|${c.person}|${c.exercise}`] = c;
}

// Fill in every calendar date × person × exercise (missing = not completed)
const exercises = ["squats", "pushups", "plank"];
const allPersons = participantsSnap.docs.map((d) => d.id).sort();
const sickDaysByPerson = {};
for (const d of participantsSnap.docs) {
  sickDaysByPerson[d.id] = new Set(d.data().sickDays ?? []);
}
const startDate = docs.map((d) => d.date).sort()[0];
const allDates = [];
for (let d = new Date(startDate); d <= new Date(); d.setUTCDate(d.getUTCDate() + 1)) {
  allDates.push(d.toISOString().slice(0, 10));
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function isoWeek(dateStr) {
  // Returns "YYYY-Www"
  const d = new Date(dateStr);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum = Math.ceil(((d - jan4) / 86400000 + jan4.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

const rows = [["date", "day_of_week", "week", "person", "exercise", "completed", "completed_at", "completed_hour", "sick_day"]];

for (const date of allDates) {
  const dow = DAY_NAMES[new Date(date).getUTCDay()];
  const week = isoWeek(date);
  for (const person of allPersons) {
    for (const exercise of exercises) {
      const rec = existing[`${date}|${person}|${exercise}`];
      const completed = rec?.completed ?? false;
      const completedAt = rec?.completedAt ?? "";
      const completedHour = completedAt ? parseInt(completedAt.slice(11, 13)) : "";
      const sickDay = sickDaysByPerson[person]?.has(date) ?? false;
      rows.push([date, dow, week, person, exercise, completed, completedAt, completedHour, sickDay]);
    }
  }
}

const csv = rows.map((r) => r.join(",")).join("\n");
const filename = `completions-${new Date().toISOString().slice(0, 10)}.csv`;
writeFileSync(filename, csv);
console.log(`Exported ${rows.length - 1} rows to ${filename}`);
