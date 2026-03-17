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

// Pivot: one row per date+person, exercises as columns
const exercises = ["squats", "pushups", "plank"];
const pivot = {};
for (const c of docs) {
  const key = `${c.date}|${c.person}`;
  if (!pivot[key]) pivot[key] = { date: c.date, person: c.person };
  pivot[key][c.exercise] = c.completed;
  pivot[key][`${c.exercise}_time`] = c.completedAt ?? "";
}

// Fill in every calendar date from earliest to today, every person all false if missing
const allPersons = participantsSnap.docs.map((d) => d.id).sort();
const startDate = docs.map((d) => d.date).sort()[0];
const allDates = [];
for (let d = new Date(startDate); d <= new Date(); d.setUTCDate(d.getUTCDate() + 1)) {
  allDates.push(d.toISOString().slice(0, 10));
}
for (const date of allDates) {
  for (const person of allPersons) {
    const key = `${date}|${person}`;
    if (!pivot[key]) pivot[key] = { date, person };
  }
}

const entries = Object.values(pivot);
entries.sort((a, b) => a.date.localeCompare(b.date) || a.person.localeCompare(b.person));

const rows = [["date", "person", ...exercises.flatMap((ex) => [ex, `${ex}_time`])]];
for (const e of entries) {
  rows.push([e.date, e.person, ...exercises.flatMap((ex) => [e[ex] ?? false, e[`${ex}_time`] ?? ""])]);
}

const csv = rows.map((r) => r.join(",")).join("\n");
const filename = `completions-${new Date().toISOString().slice(0, 10)}.csv`;
writeFileSync(filename, csv);
console.log(`Exported ${entries.length} rows to ${filename}`);
