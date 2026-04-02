import { Grade } from "../types";
import { getAllReviews, getAllPerformances } from "../db";
import { loadCachedCards } from "../sync";
import { todayStr, retrievability } from "../fsrs";

export async function renderStats(
  container: HTMLElement,
  onBack: () => void
): Promise<void> {
  const [reviews, performances] = await Promise.all([
    getAllReviews(),
    getAllPerformances(),
  ]);
  const cards = loadCachedCards();
  const today = todayStr();

  // --- Aggregate stats ---
  const totalCards = cards.length;
  const learnedCards = performances.size;
  const newCards = totalCards - learnedCards;

  // Cards due today
  let dueToday = 0;
  for (const [, perf] of performances) {
    if (perf.dueDate <= today) dueToday++;
  }

  // Maturity: young (<21 day interval) vs mature (>=21)
  let young = 0;
  let mature = 0;
  for (const [, perf] of performances) {
    if (perf.intervalDays >= 21) mature++;
    else young++;
  }

  // Average retention estimate
  const retentions: number[] = [];
  for (const [, perf] of performances) {
    const lastDate = perf.lastReviewedAt.slice(0, 10);
    const daysSince = daysBetween(lastDate, today);
    if (daysSince >= 0) {
      retentions.push(retrievability(daysSince, perf.stability));
    }
  }
  const avgRetention = retentions.length > 0
    ? retentions.reduce((a, b) => a + b, 0) / retentions.length
    : 0;

  // --- Heatmap: reviews per day (last 6 months) ---
  const heatmapDays = 182;
  const startDate = addDays(today, -heatmapDays + 1);
  const reviewsByDay = new Map<string, number>();
  for (const r of reviews) {
    const day = r.reviewedAt.slice(0, 10);
    if (day >= startDate && day <= today) {
      reviewsByDay.set(day, (reviewsByDay.get(day) || 0) + 1);
    }
  }

  // Max for color scaling
  const maxReviews = Math.max(1, ...reviewsByDay.values());

  // Build heatmap grid (weeks as columns, days as rows, Mon=0..Sun=6)
  const startDateObj = new Date(startDate + "T00:00:00Z");
  // Align to Monday
  const startDow = (startDateObj.getUTCDay() + 6) % 7; // 0=Mon
  const alignedStart = addDays(startDate, -startDow);

  const weeks: string[][] = [];
  let current = alignedStart;
  while (current <= today) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(current);
      current = addDays(current, 1);
    }
    weeks.push(week);
  }

  // --- Grade distribution (last 30 days) ---
  const thirtyDaysAgo = addDays(today, -30);
  const gradeCounts = { forgot: 0, hard: 0, good: 0, easy: 0, total: 0 };
  for (const r of reviews) {
    const day = r.reviewedAt.slice(0, 10);
    if (day >= thirtyDaysAgo && day <= today) {
      gradeCounts.total++;
      switch (r.grade) {
        case Grade.Forgot: gradeCounts.forgot++; break;
        case Grade.Hard: gradeCounts.hard++; break;
        case Grade.Good: gradeCounts.good++; break;
        case Grade.Easy: gradeCounts.easy++; break;
      }
    }
  }

  // --- Upcoming forecast (next 14 days) ---
  const forecast: { date: string; count: number }[] = [];
  for (let i = 0; i <= 14; i++) {
    const date = addDays(today, i);
    let count = 0;
    for (const [, perf] of performances) {
      if (perf.dueDate === date) count++;
    }
    forecast.push({ date, count });
  }
  const maxForecast = Math.max(1, ...forecast.map((f) => f.count));

  // --- Reviews per day (last 30 days) for streak ---
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const day = addDays(today, -i);
    if (reviewsByDay.has(day) || (i === 0 && !reviewsByDay.has(day))) {
      // Allow today to be missing (day not over yet), but only on first iteration
      if (i === 0 && !reviewsByDay.has(day)) continue;
      streak++;
    } else {
      break;
    }
  }

  container.innerHTML = `
    <div class="stats-view">
      <div class="stats-header">
        <button id="back-btn" class="btn stats-back-btn">Back</button>
        <h1>Statistics</h1>
      </div>

      <div class="stats-overview">
        <div class="stat-box">
          <div class="stat-value">${totalCards}</div>
          <div class="stat-label">Total cards</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${learnedCards}</div>
          <div class="stat-label">Learned</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${dueToday}</div>
          <div class="stat-label">Due today</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${streak}d</div>
          <div class="stat-label">Streak</div>
        </div>
      </div>

      <div class="stats-section">
        <h2>Estimated Retention</h2>
        <div class="retention-bar-container">
          <div class="retention-bar" style="width: ${(avgRetention * 100).toFixed(0)}%"></div>
          <span class="retention-label">${(avgRetention * 100).toFixed(1)}%</span>
        </div>
      </div>

      <div class="stats-section">
        <h2>Card Maturity</h2>
        <div class="maturity-bar-container">
          ${learnedCards > 0 ? `
          <div class="maturity-bar maturity-new" style="width: ${(newCards / totalCards * 100).toFixed(1)}%"></div>
          <div class="maturity-bar maturity-young" style="width: ${(young / totalCards * 100).toFixed(1)}%"></div>
          <div class="maturity-bar maturity-mature" style="width: ${(mature / totalCards * 100).toFixed(1)}%"></div>
          ` : `<div class="maturity-bar maturity-new" style="width: 100%"></div>`}
        </div>
        <div class="maturity-legend">
          <span class="legend-item"><span class="legend-dot maturity-new-dot"></span> New (${newCards})</span>
          <span class="legend-item"><span class="legend-dot maturity-young-dot"></span> Young (${young})</span>
          <span class="legend-item"><span class="legend-dot maturity-mature-dot"></span> Mature (${mature})</span>
        </div>
      </div>

      <div class="stats-section">
        <h2>Review Heatmap</h2>
        <div class="heatmap-container">
          <div class="heatmap-grid" id="heatmap"></div>
          <div class="heatmap-legend">
            <span>Less</span>
            <span class="heatmap-cell" style="background: #ebedf0"></span>
            <span class="heatmap-cell" style="background: #9be9a8"></span>
            <span class="heatmap-cell" style="background: #40c463"></span>
            <span class="heatmap-cell" style="background: #30a14e"></span>
            <span class="heatmap-cell" style="background: #216e39"></span>
            <span>More</span>
          </div>
        </div>
      </div>

      <div class="stats-section">
        <h2>Grades (Last 30 Days)</h2>
        ${gradeCounts.total > 0 ? `
        <div class="grade-bars">
          <div class="grade-row">
            <span class="grade-label">Forgot</span>
            <div class="grade-bar-track"><div class="grade-bar grade-forgot" style="width: ${(gradeCounts.forgot / gradeCounts.total * 100).toFixed(1)}%"></div></div>
            <span class="grade-count">${gradeCounts.forgot}</span>
          </div>
          <div class="grade-row">
            <span class="grade-label">Hard</span>
            <div class="grade-bar-track"><div class="grade-bar grade-hard" style="width: ${(gradeCounts.hard / gradeCounts.total * 100).toFixed(1)}%"></div></div>
            <span class="grade-count">${gradeCounts.hard}</span>
          </div>
          <div class="grade-row">
            <span class="grade-label">Good</span>
            <div class="grade-bar-track"><div class="grade-bar grade-good" style="width: ${(gradeCounts.good / gradeCounts.total * 100).toFixed(1)}%"></div></div>
            <span class="grade-count">${gradeCounts.good}</span>
          </div>
          <div class="grade-row">
            <span class="grade-label">Easy</span>
            <div class="grade-bar-track"><div class="grade-bar grade-easy" style="width: ${(gradeCounts.easy / gradeCounts.total * 100).toFixed(1)}%"></div></div>
            <span class="grade-count">${gradeCounts.easy}</span>
          </div>
        </div>
        ` : `<div class="stats-empty">No reviews in the last 30 days.</div>`}
      </div>

      <div class="stats-section">
        <h2>Upcoming Reviews</h2>
        <div class="forecast-chart" id="forecast"></div>
      </div>
    </div>
  `;

  // Render heatmap with DOM (too many cells for template string)
  const heatmapEl = container.querySelector("#heatmap")!;
  for (const week of weeks) {
    const col = document.createElement("div");
    col.className = "heatmap-col";
    for (const day of week) {
      const cell = document.createElement("div");
      cell.className = "heatmap-cell";
      const count = reviewsByDay.get(day) || 0;
      if (day < startDate || day > today) {
        cell.style.background = "transparent";
      } else if (count === 0) {
        cell.style.background = "#ebedf0";
      } else {
        const intensity = count / maxReviews;
        if (intensity < 0.25) cell.style.background = "#9be9a8";
        else if (intensity < 0.5) cell.style.background = "#40c463";
        else if (intensity < 0.75) cell.style.background = "#30a14e";
        else cell.style.background = "#216e39";
      }
      cell.title = `${day}: ${count} review${count === 1 ? "" : "s"}`;
      col.appendChild(cell);
    }
    heatmapEl.appendChild(col);
  }

  // Render forecast chart
  const forecastEl = container.querySelector("#forecast")!;
  for (const { date, count } of forecast) {
    const bar = document.createElement("div");
    bar.className = "forecast-bar-wrapper";
    const height = maxForecast > 0 ? (count / maxForecast * 100) : 0;
    bar.innerHTML = `
      <div class="forecast-bar-value">${count || ""}</div>
      <div class="forecast-bar" style="height: ${height}%"></div>
      <div class="forecast-bar-label">${date === today ? "Today" : date.slice(5)}</div>
    `;
    forecastEl.appendChild(bar);
  }

  container.querySelector("#back-btn")!.addEventListener("click", onBack);
}

// Local helpers
function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z");
  const db = new Date(b + "T00:00:00Z");
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
