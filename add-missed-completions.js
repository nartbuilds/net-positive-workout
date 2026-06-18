import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  const env = readFileSync(".env", "utf8");
  const match = env.match(/^FIREBASE_SERVICE_ACCOUNT=(.+)$/m);
  if (match) process.env.FIREBASE_SERVICE_ACCOUNT = match[1];
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const person = "Alan";
const date = "2026-06-16";
const completedAt = "2026-06-16T20:55:57+08:00";
const exercises = ["plank"];
// const exercises = ["pushups", "squats", "plank"];

for (const exercise of exercises) {
  const docId = `${date}_${person}_${exercise}`;
  const item = { date, person, exercise, completed: true, completedAt };
  await db.collection("completions").doc(docId).set(item);
  console.log(`Wrote ${docId}`);
}

console.log("Done.");
process.exit(0);
