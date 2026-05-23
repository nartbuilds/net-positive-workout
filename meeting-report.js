import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from "fs";

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  const env = readFileSync(".env", "utf8");
  const match = env.match(/^FIREBASE_SERVICE_ACCOUNT=(.+)$/m);
  if (match) process.env.FIREBASE_SERVICE_ACCOUNT = match[1];
}

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

console.log("Fetching…");
const [snap, participantsSnap] = await Promise.all([
  db.collection("completions").get(),
  db.collection("participants").get(),
]);

const EXERCISES = ["squats", "pushups", "plank"];
const people = participantsSnap.docs.map((d) => d.id).sort();
const COLORS = ["#00d9a3", "#ff6b6b", "#4dabf7", "#ffd93d", "#b197fc", "#ff922b", "#63e6be", "#f783ac"];
const personColor = Object.fromEntries(people.map((p, i) => [p, COLORS[i % COLORS.length]]));

const all = snap.docs
  .map((d) => d.data())
  .filter((c) => c.completed && c.completedAt)
  .map((c) => {
    const h = parseInt(c.completedAt.slice(11, 13));
    const m = parseInt(c.completedAt.slice(14, 16));
    return { ...c, fhour: h + m / 60 };
  });

const byPersonDate = {};
for (const c of all) {
  byPersonDate[c.person] ??= {};
  byPersonDate[c.person][c.date] ??= {};
  byPersonDate[c.person][c.date][c.exercise] = c.fhour;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stddev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmtHour = (h) => {
  if (h == null || isNaN(h)) return "—";
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
function isoWeek(dateStr) {
  const d = new Date(dateStr);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const wn = Math.ceil(((d - jan4) / 86400000 + jan4.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(wn).padStart(2, "0")}`;
}
const isWeekend = (dateStr) => {
  const dow = new Date(dateStr).getUTCDay();
  return dow === 0 || dow === 6;
};

const personDays = {};
for (const p of people) {
  personDays[p] = [];
  for (const [date, ex] of Object.entries(byPersonDate[p] ?? {})) {
    const hours = EXERCISES.map((e) => ex[e]).filter((h) => h != null);
    if (hours.length < EXERCISES.length) continue;
    personDays[p].push({
      date,
      week: isoWeek(date),
      weekend: isWeekend(date),
      first: Math.min(...hours),
      last: Math.max(...hours),
      order: EXERCISES.slice().sort((a, b) => ex[a] - ex[b]).join("→"),
    });
  }
  personDays[p].sort((a, b) => a.date.localeCompare(b.date));
}

// METRIC 1: weekly stddev of last-exercise hour
const variance = {};
for (const p of people) {
  const byWeek = {};
  for (const d of personDays[p]) (byWeek[d.week] ??= []).push(d.last);
  variance[p] = Object.entries(byWeek).sort().map(([week, hs]) => ({ week, n: hs.length, mean: mean(hs), stddev: stddev(hs) }));
}

// METRIC 2: weekend drift
const drift = {};
for (const p of people) {
  const byWeek = {};
  for (const d of personDays[p]) {
    byWeek[d.week] ??= { we: [], wd: [] };
    (d.weekend ? byWeek[d.week].we : byWeek[d.week].wd).push(d.last);
  }
  drift[p] = Object.entries(byWeek).sort().map(([week, { we, wd }]) => ({
    week,
    weekendMean: we.length ? mean(we) : null,
    weekdayMean: wd.length ? mean(wd) : null,
    drift: we.length && wd.length ? mean(we) - mean(wd) : null,
  }));
}

// METRIC 3: group "last person done"
const allDates = [...new Set(all.map((c) => c.date))].sort();
const groupLast = [];
const finisherTally = Object.fromEntries(people.map((p) => [p, { first: 0, last: 0 }]));
for (const date of allDates) {
  const perPerson = people.map((p) => ({ p, h: personDays[p].find((d) => d.date === date)?.last }));
  if (perPerson.some((x) => x.h == null)) continue;
  const sorted = perPerson.slice().sort((a, b) => a.h - b.h);
  const firstP = sorted[0], lastP = sorted[sorted.length - 1];
  finisherTally[firstP.p].first++;
  finisherTally[lastP.p].last++;
  groupLast.push({
    date,
    week: isoWeek(date),
    lastPerson: lastP.p,
    firstPerson: firstP.p,
    lastPersonHour: lastP.h,
    firstPersonHour: firstP.h,
    spread: lastP.h - firstP.h,
  });
}
const groupByWeek = {};
for (const g of groupLast) (groupByWeek[g.week] ??= []).push(g);
function topByCount(items) {
  const counts = {};
  for (const x of items) counts[x] = (counts[x] ?? 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "—";
  const top = ranked[0][1];
  const winners = ranked.filter(([, n]) => n === top).map(([p]) => p);
  return `${winners.join("/")} (${top})`;
}
const groupWeekly = Object.entries(groupByWeek).sort().map(([week, days]) => ({
  week,
  n: days.length,
  avgLastPerson: mean(days.map((d) => d.lastPersonHour)),
  avgSpread: mean(days.map((d) => d.spread)),
  pacesetter: topByCount(days.map((d) => d.firstPerson)),
  anchor: topByCount(days.map((d) => d.lastPerson)),
}));

// METRIC 5: gap between first & last exercise
const gap = {};
for (const p of people) {
  const byWeek = {};
  for (const d of personDays[p]) (byWeek[d.week] ??= []).push(d.last - d.first);
  gap[p] = Object.entries(byWeek).sort().map(([week, gaps]) => ({
    week,
    n: gaps.length,
    avgGap: mean(gaps),
    medianGap: median(gaps),
    sameBlock: (gaps.filter((g) => g <= 0.5).length / gaps.length) * 100,
    allDay: (gaps.filter((g) => g >= 6).length / gaps.length) * 100,
  }));
}

// METRIC 4: exercise order
const order = {};
for (const p of people) {
  const counts = {};
  for (const d of personDays[p]) counts[d.order] = (counts[d.order] ?? 0) + 1;
  const total = personDays[p].length;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const half = Math.floor(personDays[p].length / 2);
  const firstHalf = personDays[p].slice(0, half);
  const secondHalf = personDays[p].slice(half);
  const topOrder = top?.[0];
  const share = (arr) => (arr.filter((d) => d.order === topOrder).length / (arr.length || 1)) * 100;
  order[p] = {
    total,
    topOrder,
    topShare: total ? (top[1] / total) * 100 : 0,
    firstHalfShare: share(firstHalf),
    secondHalfShare: share(secondHalf),
    distribution: ranked.map(([o, n]) => ({ order: o, n, pct: (n / total) * 100 })),
  };
}

// ───── Per-person plain-English summaries ─────
function sumConsistency(p) {
  const allHs = personDays[p].map((d) => d.last);
  const sd = stddev(allHs);
  const f = variance[p][0], l = variance[p][variance[p].length - 1];
  const delta = f && l ? l.stddev - f.stddev : 0;
  const tone = sd < 1 ? "very tight — wrap-up time is locked in"
    : sd < 2 ? "moderately consistent"
    : sd < 3 ? "loose — finishes at varying times"
    : "highly variable";
  const trend = delta < -0.3 ? "consolidating ✅" : delta > 0.3 ? "loosening ⚠️" : "stable";
  return `Average wrap-up <b>${fmtHour(mean(allHs))}</b> · stddev <b>${sd.toFixed(2)}h</b> (${tone}) · trend: <b>${trend}</b>`;
}

function sumCompactness(p) {
  const gaps = personDays[p].map((d) => d.last - d.first);
  const avgG = mean(gaps);
  const sb = (gaps.filter((g) => g <= 0.5).length / gaps.length) * 100;
  const ad = (gaps.filter((g) => g >= 6).length / gaps.length) * 100;
  const style = avgG < 1 ? "knocks it out in one block"
    : avgG < 3 ? "short workout window"
    : avgG < 8 ? "spreads across part of the day"
    : "all-day grind";
  const f = gap[p][0], l = gap[p][gap[p].length - 1];
  const delta = f && l ? l.avgGap - f.avgGap : 0;
  const trend = delta < -0.5 ? "tightening into a session ✅" : delta > 0.5 ? "spreading out ⚠️" : "stable";
  return `Avg gap <b>${avgG.toFixed(2)}h</b> (${style}) · <b>${sb.toFixed(0)}%</b> single-block · <b>${ad.toFixed(0)}%</b> all-day · trend: <b>${trend}</b>`;
}

function sumOrder(p) {
  const o = order[p];
  const drift = o.secondHalfShare - o.firstHalfShare;
  const settled = o.topShare > 80 ? "rock-solid routine"
    : o.topShare > 50 ? "preferred order most days"
    : o.topShare > 30 ? "loose preference"
    : "no fixed routine";
  const trend = drift > 10 ? "consolidating ✅" : drift < -10 ? "diversifying" : "stable";
  return `Top order <b>${o.topOrder}</b> (<b>${o.topShare.toFixed(0)}%</b> of days) · ${settled} · first half ${o.firstHalfShare.toFixed(0)}% → second half ${o.secondHalfShare.toFixed(0)}% (<b>${trend}</b>)`;
}

function sumDrift(p) {
  const wd = personDays[p].filter((d) => !d.weekend).map((d) => d.last);
  const we = personDays[p].filter((d) => d.weekend).map((d) => d.last);
  if (!wd.length || !we.length) return "Not enough weekday/weekend data.";
  const od = mean(we) - mean(wd);
  const tone = Math.abs(od) < 0.5 ? "no real drift — same regardless of day ✅"
    : od > 0 ? `slips <b>${od.toFixed(1)}h later</b> on weekends`
    : `actually <b>${(-od).toFixed(1)}h earlier</b> on weekends`;
  return `Weekday <b>${fmtHour(mean(wd))}</b> · weekend <b>${fmtHour(mean(we))}</b> · ${tone}`;
}

// MD-friendly versions (no <b>)
const stripB = (s) => s.replace(/<\/?b>/g, "**");

// ───── SVG line chart: last-exercise hour over all 60 days, per person ─────
function buildSvg() {
  const W = 900, H = 420;
  const padL = 50, padR = 180, padT = 30, padB = 50;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xDates = allDates;
  const xIdx = Object.fromEntries(xDates.map((d, i) => [d, i]));
  const xScale = (i) => padL + (plotW * i) / Math.max(1, xDates.length - 1);
  const yScale = (h) => padT + plotH - (h / 24) * plotH;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="11">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#1a1a1a"/>`);

  // Y gridlines every 4h
  for (let h = 0; h <= 24; h += 4) {
    const y = yScale(h);
    parts.push(`<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="#333" stroke-width="0.5"/>`);
    parts.push(`<text x="${padL - 6}" y="${y + 3}" fill="#888" text-anchor="end">${String(h).padStart(2, "0")}:00</text>`);
  }

  // X axis: weekly tick marks
  let lastWeek = "";
  xDates.forEach((d, i) => {
    const w = isoWeek(d);
    if (w !== lastWeek) {
      lastWeek = w;
      const x = xScale(i);
      parts.push(`<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="#2a2a2a" stroke-width="0.5"/>`);
      parts.push(`<text x="${x}" y="${H - padB + 14}" fill="#888" text-anchor="middle">${d.slice(5)}</text>`);
    }
  });

  // Lines per person
  for (const p of people) {
    const pts = personDays[p]
      .filter((d) => xIdx[d.date] != null)
      .map((d) => `${xScale(xIdx[d.date])},${yScale(d.last)}`);
    if (pts.length < 2) continue;
    parts.push(`<polyline fill="none" stroke="${personColor[p]}" stroke-width="2" stroke-linejoin="round" points="${pts.join(" ")}"/>`);
    // dots
    for (const d of personDays[p]) {
      if (xIdx[d.date] == null) continue;
      parts.push(`<circle cx="${xScale(xIdx[d.date])}" cy="${yScale(d.last)}" r="2" fill="${personColor[p]}"/>`);
    }
  }

  // Legend
  people.forEach((p, i) => {
    const ly = padT + 10 + i * 18;
    parts.push(`<rect x="${padL + plotW + 20}" y="${ly - 8}" width="12" height="12" fill="${personColor[p]}"/>`);
    parts.push(`<text x="${padL + plotW + 38}" y="${ly + 2}" fill="#ddd">${p}</text>`);
  });

  parts.push(`<text x="${padL}" y="20" fill="#ddd" font-weight="bold">Last-exercise hour, each day</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}

const assetsDir = "report-assets";
mkdirSync(assetsDir, { recursive: true });
const svgPath = `${assetsDir}/completion-times.svg`;
writeFileSync(svgPath, buildSvg());

// ───── Unicode heatmaps per person: day-of-week × hour ─────
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BLOCKS = [" ", "░", "▒", "▓", "█"];
function buildHeatmap(p) {
  // grid[dow 0=Mon..6=Sun][hour 0..23] = count of completions
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of all.filter((x) => x.person === p)) {
    const jsDow = new Date(c.date).getUTCDay(); // 0=Sun..6=Sat
    const dow = (jsDow + 6) % 7; // 0=Mon..6=Sun
    grid[dow][Math.floor(c.fhour)]++;
  }
  const max = Math.max(1, ...grid.flat());
  const lines = ["     " + Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")[0] === "0" || String(h).padStart(2, "0")[1] === "0" ? String(h).padStart(2, "0")[0] : " ").join("")];
  lines[0] = "     " + Array.from({ length: 24 }, (_, h) => Math.floor(h / 10)).join("");
  lines.push("     " + Array.from({ length: 24 }, (_, h) => h % 10).join(""));
  for (let d = 0; d < 7; d++) {
    let row = `${DOW[d]}  `;
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h];
      const bucket = v === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4));
      row += BLOCKS[bucket];
    }
    lines.push(row);
  }
  return lines.join("\n");
}

// ───── Render markdown ─────
const out = [];
const push = (s = "") => out.push(s);

push(`# 60-Day Recap Report`);
push(`Generated ${new Date().toISOString().slice(0, 10)} · Participants: ${people.join(", ")} · Days analyzed: ${groupLast.length}`);
push();

push(`## Completion times across the challenge`);
push(`Each line shows one person's *last exercise of the day*, every day. Flat horizontal line = locked-in routine. Drifting downward = trending earlier.`);
push();
push(`![](${svgPath})`);
push();

push(`## 1. Completion-hour consistency`);
push(`Lower stddev = more automatic / habit-like.`);
push();
for (const p of people) {
  push(`### ${p}`);
  push(`> ${stripB(sumConsistency(p))}`);
  push();
  push(`| Week | Days | Avg last-exercise | Stddev (hrs) |`);
  push(`|---|---|---|---|`);
  for (const w of variance[p]) push(`| ${w.week} | ${w.n} | ${fmtHour(w.mean)} | ${w.stddev.toFixed(2)} |`);
  const allHs = personDays[p].map((d) => d.last);
  push(`| **Overall** | **${allHs.length}** | **${fmtHour(mean(allHs))}** | **${stddev(allHs).toFixed(2)}** |`);
  push();
}

push(`## 2. Session compactness — gap between first and last exercise`);
push(`Small gap = one-block workout (≤30 min). Large gap = spread across the day.`);
push();
for (const p of people) {
  push(`### ${p}`);
  push(`> ${stripB(sumCompactness(p))}`);
  push();
  push(`| Week | Days | Avg gap (hrs) | Median gap | % single-block (≤30m) | % all-day (≥6h) |`);
  push(`|---|---|---|---|---|---|`);
  for (const w of gap[p]) push(`| ${w.week} | ${w.n} | ${w.avgGap.toFixed(2)} | ${w.medianGap.toFixed(2)} | ${w.sameBlock.toFixed(0)}% | ${w.allDay.toFixed(0)}% |`);
  const allGaps = personDays[p].map((d) => d.last - d.first);
  push(`| **Overall** | **${allGaps.length}** | **${mean(allGaps).toFixed(2)}** | **${median(allGaps).toFixed(2)}** | **${((allGaps.filter((g) => g <= 0.5).length / allGaps.length) * 100).toFixed(0)}%** | **${((allGaps.filter((g) => g >= 6).length / allGaps.length) * 100).toFixed(0)}%** |`);
  push();
}

push(`## 3. Exercise-order stability`);
push(`Fixed order = workout has become a script — less decision-making, more autopilot.`);
push();
for (const p of people) {
  push(`### ${p}`);
  push(`> ${stripB(sumOrder(p))}`);
  push();
  push(`| Order | Days | % |`);
  push(`|---|---|---|`);
  for (const d of order[p].distribution) push(`| ${d.order} | ${d.n} | ${d.pct.toFixed(0)}% |`);
  push();
}

push(`## 4. Weekend drift`);
push(`Weekend hour minus weekday hour. Shrinking toward 0 = identity habit, not work-schedule habit.`);
push();
for (const p of people) {
  push(`### ${p}`);
  push(`> ${stripB(sumDrift(p))}`);
  push();
  push(`| Week | Weekday avg | Weekend avg | Drift (hrs) |`);
  push(`|---|---|---|---|`);
  for (const w of drift[p]) {
    push(`| ${w.week} | ${w.weekdayMean != null ? fmtHour(w.weekdayMean) : "—"} | ${w.weekendMean != null ? fmtHour(w.weekendMean) : "—"} | ${w.drift != null ? (w.drift >= 0 ? "+" : "") + w.drift.toFixed(2) : "—"} |`);
  }
  const wd = personDays[p].filter((d) => !d.weekend).map((d) => d.last);
  const we = personDays[p].filter((d) => d.weekend).map((d) => d.last);
  const overallDrift = wd.length && we.length ? mean(we) - mean(wd) : null;
  push(`| **Overall** | **${wd.length ? fmtHour(mean(wd)) : "—"}** | **${we.length ? fmtHour(mean(we)) : "—"}** | **${overallDrift != null ? (overallDrift >= 0 ? "+" : "") + overallDrift.toFixed(2) : "—"}** |`);
  push();
}

push(`## 5. Group cohesion — when's the last person done?`);
push(`Tracks the latest finisher each day. Trending earlier or tighter spread = group pulling itself together.`);
push();
push(`| Week | Days | Avg "last done" | Avg spread | 🐤 Pacesetter | ⚓ Anchor |`);
push(`|---|---|---|---|---|---|`);
for (const w of groupWeekly) push(`| ${w.week} | ${w.n} | ${fmtHour(w.avgLastPerson)} | ${w.avgSpread.toFixed(2)} hrs | ${w.pacesetter} | ${w.anchor} |`);
const allLast = groupLast.map((d) => d.lastPersonHour);
const allSpread = groupLast.map((d) => d.spread);
const overallPace = topByCount(groupLast.map((d) => d.firstPerson));
const overallAnchor = topByCount(groupLast.map((d) => d.lastPerson));
push(`| **Overall** | **${groupLast.length}** | **${fmtHour(mean(allLast))}** | **${mean(allSpread).toFixed(2)} hrs** | **${overallPace}** | **${overallAnchor}** |`);
if (groupWeekly.length >= 2) {
  const f = groupWeekly[0], l = groupWeekly[groupWeekly.length - 1];
  push();
  push(`**Trend:** last-person time ${fmtHour(f.avgLastPerson)} → ${fmtHour(l.avgLastPerson)} (${(l.avgLastPerson - f.avgLastPerson >= 0 ? "+" : "") + (l.avgLastPerson - f.avgLastPerson).toFixed(2)} hrs)`);
  push(`**Spread:** ${f.avgSpread.toFixed(2)} → ${l.avgSpread.toFixed(2)} hrs (${l.avgSpread - f.avgSpread < 0 ? "✅ tightening" : "⚠️ widening"})`);
}
push();

push(`### Finisher tally — who's the pacesetter, who's the anchor?`);
push(`Days each person was the *first* finisher (early bird 🐤) vs the *last* finisher (anchor ⚓) of the day.`);
push();
push(`| Person | 🐤 First | ⚓ Last |`);
push(`|---|---|---|`);
const totalDays = groupLast.length;
const sortedByFirst = people.slice().sort((a, b) => finisherTally[b].first - finisherTally[a].first);
for (const p of sortedByFirst) {
  const t = finisherTally[p];
  push(`| ${p} | ${t.first} (${((t.first / totalDays) * 100).toFixed(0)}%) | ${t.last} (${((t.last / totalDays) * 100).toFixed(0)}%) |`);
}
const topFirst = sortedByFirst[0];
const topLast = people.slice().sort((a, b) => finisherTally[b].last - finisherTally[a].last)[0];
push();
push(`**Pacesetter:** ${topFirst} (first ${finisherTally[topFirst].first}/${totalDays} days)  ·  **Anchor:** ${topLast} (last ${finisherTally[topLast].last}/${totalDays} days)`);
push();

push(`## 6. Time-of-day heatmap (day-of-week × hour)`);
push(`Where do completions cluster across the week? Each cell = number of exercise check-offs in that hour. Darker = more activity.`);
push(`Scale per person (normalized to that person's max). Legend: \` \` none · \`░\` low · \`▒\` mid · \`▓\` high · \`█\` peak.`);
push();
for (const p of people) {
  push(`### ${p}`);
  push("```");
  push(buildHeatmap(p));
  push("```");
  push();
}

const filename = `meeting-report-${new Date().toISOString().slice(0, 10)}.md`;
writeFileSync(filename, out.join("\n"));

// ───── Interactive HTML report (Plotly via CDN) ─────
function heatmapGrid(p) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of all.filter((x) => x.person === p)) {
    const jsDow = new Date(c.date).getUTCDay();
    const dow = (jsDow + 6) % 7;
    grid[dow][Math.floor(c.fhour)]++;
  }
  return grid;
}

function renderHtml() {
  // Trace data
  const lastHourTraces = people.map((p) => ({
    type: "scatter",
    mode: "lines+markers",
    name: p,
    x: personDays[p].map((d) => d.date),
    y: personDays[p].map((d) => d.last),
    line: { color: personColor[p], width: 2 },
    marker: { size: 5 },
    hovertemplate: `<b>${p}</b><br>%{x}<br>Last exercise: %{y:.2f}h<extra></extra>`,
  }));

  const perExerciseTraces = [];
  for (const p of people) {
    for (const ex of EXERCISES) {
      const points = all
        .filter((c) => c.person === p && c.exercise === ex)
        .sort((a, b) => a.date.localeCompare(b.date));
      perExerciseTraces.push({
        type: "scatter",
        mode: "lines+markers",
        name: `${p} · ${ex}`,
        legendgroup: p,
        x: points.map((c) => c.date),
        y: points.map((c) => c.fhour),
        line: { color: personColor[p], width: 1.5, dash: ex === "squats" ? "solid" : ex === "pushups" ? "dash" : "dot" },
        marker: { size: 4 },
        visible: ex === "squats" ? true : "legendonly",
        hovertemplate: `<b>${p} · ${ex}</b><br>%{x}<br>%{y:.2f}h<extra></extra>`,
      });
    }
  }

  const heatmapTraces = people.map((p, i) => ({
    type: "heatmap",
    z: heatmapGrid(p),
    x: Array.from({ length: 24 }, (_, h) => h),
    y: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    colorscale: "Viridis",
    showscale: i === people.length - 1,
    xaxis: `x${i + 1}`,
    yaxis: `y${i + 1}`,
    hovertemplate: `<b>${p}</b><br>%{y} %{x}:00<br>%{z} completions<extra></extra>`,
  }));

  // Tables → HTML
  const tableRow = (cells, bold = false) =>
    `<tr>${cells.map((c) => `<${bold ? "th" : "td"}>${c}</${bold ? "th" : "td"}>`).join("")}</tr>`;

  const varianceTables = people.map((p) => {
    const allHs = personDays[p].map((d) => d.last);
    const rows = [
      tableRow(["Week", "Days", "Avg last-exercise", "Stddev (hrs)"], true),
      ...variance[p].map((w) => tableRow([w.week, w.n, fmtHour(w.mean), w.stddev.toFixed(2)])),
      tableRow([`<b>Overall</b>`, `<b>${allHs.length}</b>`, `<b>${fmtHour(mean(allHs))}</b>`, `<b>${stddev(allHs).toFixed(2)}</b>`]),
    ].join("");
    return `<h3>${p}</h3><p class="summary">${sumConsistency(p)}</p><div class="table-wrap"><table>${rows}</table></div>`;
  }).join("");

  const driftTables = people.map((p) => {
    const wd = personDays[p].filter((d) => !d.weekend).map((d) => d.last);
    const we = personDays[p].filter((d) => d.weekend).map((d) => d.last);
    const od = wd.length && we.length ? mean(we) - mean(wd) : null;
    const rows = [
      tableRow(["Week", "Weekday avg", "Weekend avg", "Drift (hrs)"], true),
      ...drift[p].map((w) =>
        tableRow([
          w.week,
          w.weekdayMean != null ? fmtHour(w.weekdayMean) : "—",
          w.weekendMean != null ? fmtHour(w.weekendMean) : "—",
          w.drift != null ? (w.drift >= 0 ? "+" : "") + w.drift.toFixed(2) : "—",
        ])
      ),
      tableRow([
        `<b>Overall</b>`,
        `<b>${wd.length ? fmtHour(mean(wd)) : "—"}</b>`,
        `<b>${we.length ? fmtHour(mean(we)) : "—"}</b>`,
        `<b>${od != null ? (od >= 0 ? "+" : "") + od.toFixed(2) : "—"}</b>`,
      ]),
    ].join("");
    return `<h3>${p}</h3><p class="summary">${sumDrift(p)}</p><div class="table-wrap"><table>${rows}</table></div>`;
  }).join("");

  const overallPaceH = topByCount(groupLast.map((d) => d.firstPerson));
  const overallAnchorH = topByCount(groupLast.map((d) => d.lastPerson));
  const cohesionRows = [
    tableRow(["Week", "Days", "Avg \"last done\"", "Avg spread", "🐤 Pacesetter", "⚓ Anchor"], true),
    ...groupWeekly.map((w) => tableRow([w.week, w.n, fmtHour(w.avgLastPerson), w.avgSpread.toFixed(2) + " hrs", w.pacesetter, w.anchor])),
    tableRow([
      `<b>Overall</b>`,
      `<b>${groupLast.length}</b>`,
      `<b>${fmtHour(mean(groupLast.map((d) => d.lastPersonHour)))}</b>`,
      `<b>${mean(groupLast.map((d) => d.spread)).toFixed(2)} hrs</b>`,
      `<b>${overallPaceH}</b>`,
      `<b>${overallAnchorH}</b>`,
    ]),
  ].join("");
  const cohesionTable = `<div class="table-wrap"><table>${cohesionRows}</table></div>`;

  const totalDaysCohesion = groupLast.length;
  const sortedByFirst = people.slice().sort((a, b) => finisherTally[b].first - finisherTally[a].first);
  const topFirst = sortedByFirst[0];
  const topLast = people.slice().sort((a, b) => finisherTally[b].last - finisherTally[a].last)[0];
  const tallyRows = [
    tableRow(["Person", "🐤 First finisher", "⚓ Last finisher"], true),
    ...sortedByFirst.map((p) => {
      const t = finisherTally[p];
      return tableRow([
        `<span style="color:${personColor[p]}">●</span> ${p}`,
        `${t.first} (${((t.first / totalDaysCohesion) * 100).toFixed(0)}%)`,
        `${t.last} (${((t.last / totalDaysCohesion) * 100).toFixed(0)}%)`,
      ]);
    }),
  ].join("");
  const tallyTable = `<p class="summary"><b>Pacesetter:</b> ${topFirst} — first ${finisherTally[topFirst].first}/${totalDaysCohesion} days · <b>Anchor:</b> ${topLast} — last ${finisherTally[topLast].last}/${totalDaysCohesion} days</p><div class="table-wrap"><table>${tallyRows}</table></div>`;

  const gapTables = people.map((p) => {
    const allGaps = personDays[p].map((d) => d.last - d.first);
    const rows = [
      tableRow(["Week", "Days", "Avg gap (hrs)", "Median gap", "% single-block", "% all-day"], true),
      ...gap[p].map((w) =>
        tableRow([w.week, w.n, w.avgGap.toFixed(2), w.medianGap.toFixed(2), w.sameBlock.toFixed(0) + "%", w.allDay.toFixed(0) + "%"])
      ),
      tableRow([
        `<b>Overall</b>`,
        `<b>${allGaps.length}</b>`,
        `<b>${mean(allGaps).toFixed(2)}</b>`,
        `<b>${median(allGaps).toFixed(2)}</b>`,
        `<b>${((allGaps.filter((g) => g <= 0.5).length / allGaps.length) * 100).toFixed(0)}%</b>`,
        `<b>${((allGaps.filter((g) => g >= 6).length / allGaps.length) * 100).toFixed(0)}%</b>`,
      ]),
    ].join("");
    return `<h3>${p}</h3><p class="summary">${sumCompactness(p)}</p><div class="table-wrap"><table>${rows}</table></div>`;
  }).join("");

  const orderTables = people.map((p) => {
    const o = order[p];
    const rows = [
      tableRow(["Order", "Days", "%"], true),
      ...o.distribution.map((d) => tableRow([d.order, d.n, d.pct.toFixed(0) + "%"])),
    ].join("");
    return `<h3>${p}</h3><p class="summary">${sumOrder(p)}</p><div class="table-wrap"><table>${rows}</table></div>`;
  }).join("");

  // Heatmap subplot layout
  const heatmapLayout = {
    grid: { rows: people.length, columns: 1, pattern: "independent" },
    height: 180 * people.length,
    margin: { t: 30, l: 60, r: 40, b: 40 },
    paper_bgcolor: "#1a1a1a",
    plot_bgcolor: "#1a1a1a",
    font: { color: "#ddd" },
    annotations: people.map((p, i) => ({
      text: p,
      xref: "paper",
      yref: "paper",
      x: 0,
      xanchor: "left",
      y: 1 - i / people.length,
      yanchor: "top",
      showarrow: false,
      font: { size: 14, color: personColor[p] },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>60-Day Recap Report</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f0f0f; color: #ddd; max-width: 1100px; margin: 0 auto; padding: 24px; line-height: 1.5; }
  h1 { color: #00d9a3; border-bottom: 1px solid #333; padding-bottom: 8px; font-size: 1.6rem; }
  h2 { color: #4dabf7; margin-top: 40px; border-bottom: 1px solid #222; padding-bottom: 4px; font-size: 1.2rem; }
  h3 { color: #ddd; margin-top: 24px; font-size: 1rem; }
  p.hint { color: #888; font-style: italic; }
  p.summary { background: #1a1a1a; border-left: 3px solid #00d9a3; padding: 8px 12px; margin: 8px 0 12px; color: #ddd; font-size: 13px; border-radius: 0 4px 4px 0; }
  p.summary b { color: #00d9a3; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 12px 0 24px; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; min-width: 360px; }
  th, td { padding: 6px 10px; border-bottom: 1px solid #2a2a2a; text-align: left; white-space: nowrap; }
  th { background: #1a1a1a; color: #4dabf7; font-weight: 600; position: sticky; top: 0; }
  tr:last-child td { background: #1a1a1a; }
  .chart { background: #1a1a1a; border-radius: 6px; padding: 8px; margin: 16px 0; }
  .tip { background: #1a2530; border-left: 3px solid #4dabf7; padding: 10px 14px; margin: 12px 0; color: #aaa; font-size: 13px; }
  @media (max-width: 640px) {
    body { padding: 12px; }
    h1 { font-size: 1.3rem; }
    h2 { font-size: 1.05rem; margin-top: 28px; }
    h3 { font-size: 0.95rem; }
    .chart { padding: 4px; }
    table { font-size: 12px; }
    th, td { padding: 5px 8px; }
  }
</style>
</head>
<body>

<h1>60-Day Recap Report</h1>
<p>Generated ${new Date().toISOString().slice(0, 10)} · Participants: ${people.join(", ")} · Days analyzed: ${groupLast.length}</p>

<div class="tip"><b>Tip:</b> click any name in a chart legend to hide it. Double-click to isolate. Drag to zoom. Double-click empty space to reset.</div>

<h2>Last exercise of the day — per person, over time</h2>
<p class="hint">Flat line = locked-in routine. Trending down = moving earlier in the day.</p>
<div id="chart-last" class="chart"></div>

<h2>Per-exercise completion times</h2>
<p class="hint">Each (person × exercise) is its own trace. Click legend to toggle. Line style: <b>solid</b>=squats, <b>dashed</b>=pushups, <b>dotted</b>=plank. (Only squats shown by default — click others on.)</p>
<div id="chart-per-exercise" class="chart"></div>

<h2>Activity heatmap — day-of-week × hour-of-day</h2>
<p class="hint">Where in the week does each person's activity cluster?</p>
<div id="chart-heatmap" class="chart"></div>

<h2>1. Completion-hour consistency</h2>
<p class="hint">Lower stddev = more automatic / habit-like.</p>
${varianceTables}

<h2>2. Session compactness — gap between first and last exercise</h2>
<p class="hint">Small gap = one-block workout. Large gap = spread across the day.</p>
${gapTables}

<h2>3. Exercise-order stability</h2>
<p class="hint">Fixed order = workout has become a script, less decision-making.</p>
${orderTables}

<h2>4. Weekend drift</h2>
<p class="hint">Weekend hour minus weekday hour. Shrinking toward 0 = identity habit, not work-schedule habit.</p>
${driftTables}

<h2>5. Group cohesion — when's the last person done?</h2>
<p class="hint">The latest finisher each day. Tightening spread = group pulling itself together.</p>
${cohesionTable}

<h3>Finisher tally — pacesetter vs anchor</h3>
<p class="hint">Days each person was the <i>first</i> 🐤 or <i>last</i> ⚓ finisher of the day.</p>
${tallyTable}

<script>
  const dark = {
    paper_bgcolor: "#1a1a1a",
    plot_bgcolor: "#1a1a1a",
    font: { color: "#ddd" },
    xaxis: { gridcolor: "#2a2a2a", title: "Date" },
    yaxis: { gridcolor: "#2a2a2a", title: "Hour of day", range: [0, 24], dtick: 4 },
    legend: { bgcolor: "rgba(0,0,0,0)" },
    margin: { t: 30, l: 60, r: 30, b: 60 },
  };

  Plotly.newPlot("chart-last", ${JSON.stringify(lastHourTraces)}, { ...dark, height: 450 }, { responsive: true, displaylogo: false });
  Plotly.newPlot("chart-per-exercise", ${JSON.stringify(perExerciseTraces)}, { ...dark, height: 500 }, { responsive: true, displaylogo: false });
  Plotly.newPlot("chart-heatmap", ${JSON.stringify(heatmapTraces)}, ${JSON.stringify(heatmapLayout)}, { responsive: true, displaylogo: false });
</script>

</body>
</html>`;
}

const reportsDir = "reports";
mkdirSync(reportsDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const htmlPath = `${reportsDir}/recap-${today}.html`;
writeFileSync(htmlPath, renderHtml());

// Manifest: every recap-*.html file in reports/, sorted desc by date in filename
const reports = readdirSync(reportsDir)
  .filter((f) => /^recap-\d{4}-\d{2}-\d{2}\.html$/.test(f))
  .sort()
  .reverse();
const manifestPath = `${reportsDir}/manifest.json`;
writeFileSync(manifestPath, JSON.stringify({ reports, latest: reports[0] }, null, 2));

console.log(`Wrote:`);
console.log(`  ${filename}`);
console.log(`  ${svgPath}`);
console.log(`  ${htmlPath}`);
console.log(`  ${manifestPath}  ← app reads this to find the latest`);
