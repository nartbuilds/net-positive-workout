// One-off: rewrite the <script> block in an existing reports/recap-*.html
// with the mobile-responsive version, without re-querying Firestore.
import { readFileSync, writeFileSync } from "fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node update-recap-html.js reports/recap-YYYY-MM-DD.html");
  process.exit(1);
}

const html = readFileSync(path, "utf8");

function extractTraces(chartId) {
  const re = new RegExp(`Plotly\\.newPlot\\("${chartId}",\\s*(\\[[\\s\\S]*?\\]),\\s*\\{`);
  const m = html.match(re);
  if (!m) throw new Error(`Could not find traces for ${chartId}`);
  return JSON.parse(m[1]);
}

const lastHourTraces = extractTraces("chart-last");
const perExerciseTraces = extractTraces("chart-per-exercise");
const heatmapTraces = extractTraces("chart-heatmap");

const people = lastHourTraces.map((t) => t.name);
const personColor = Object.fromEntries(lastHourTraces.map((t) => [t.name, t.line.color]));

const newScript = `<script>
  const people = ${JSON.stringify(people)};
  const personColor = ${JSON.stringify(personColor)};
  const heatmapTraces = ${JSON.stringify(heatmapTraces)};
  const lastHourTraces = ${JSON.stringify(lastHourTraces)};
  const perExerciseTraces = ${JSON.stringify(perExerciseTraces)};

  const isMobile = () => window.innerWidth < 700;

  function darkBase() {
    const m = isMobile();
    return {
      paper_bgcolor: "#1a1a1a",
      plot_bgcolor: "#1a1a1a",
      font: { color: "#ddd", size: m ? 10 : 12 },
      xaxis: { gridcolor: "#2a2a2a", title: m ? "" : "Date", tickfont: { size: m ? 9 : 11 } },
      yaxis: { gridcolor: "#2a2a2a", title: m ? "" : "Hour of day", range: [0, 24], dtick: m ? 6 : 4, tickfont: { size: m ? 9 : 11 } },
      legend: {
        bgcolor: "rgba(0,0,0,0)",
        orientation: "h",
        x: 0, xanchor: "left",
        y: -0.15, yanchor: "top",
        font: { size: m ? 10 : 12 },
      },
      margin: { t: 20, l: m ? 38 : 55, r: m ? 10 : 25, b: m ? 80 : 70 },
    };
  }

  function buildHeatmapLayout() {
    const m = isMobile();
    return {
      grid: { rows: people.length, columns: 1, pattern: "independent" },
      height: (m ? 140 : 180) * people.length,
      margin: { t: 24, l: m ? 38 : 55, r: m ? 10 : 30, b: 30 },
      paper_bgcolor: "#1a1a1a",
      plot_bgcolor: "#1a1a1a",
      font: { color: "#ddd", size: m ? 10 : 12 },
      annotations: people.map((p, i) => ({
        text: p,
        xref: "paper", yref: "paper",
        x: 0, xanchor: "left",
        y: 1 - i / people.length, yanchor: "top",
        showarrow: false,
        font: { size: m ? 12 : 14, color: personColor[p] },
      })),
    };
  }

  function chartHeights() {
    const m = isMobile();
    return { last: m ? 360 : 450, perEx: m ? 420 : 500 };
  }

  function renderCharts() {
    const h = chartHeights();
    Plotly.react("chart-last", lastHourTraces, { ...darkBase(), height: h.last }, { responsive: true, displaylogo: false });
    Plotly.react("chart-per-exercise", perExerciseTraces, { ...darkBase(), height: h.perEx }, { responsive: true, displaylogo: false });
    Plotly.react("chart-heatmap", heatmapTraces, buildHeatmapLayout(), { responsive: true, displaylogo: false });
  }

  renderCharts();
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 200);
  });
</script>`;

const updated = html.replace(/<script>[\s\S]*?<\/script>\s*<\/body>/, newScript + "\n\n</body>");
if (updated === html) {
  console.error("No script block found to replace");
  process.exit(1);
}
writeFileSync(path, updated);
console.log(`Updated ${path} (${people.length} people, ${heatmapTraces.length} heatmaps)`);
