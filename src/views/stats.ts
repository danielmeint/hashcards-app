import { html, nothing, render, TemplateResult } from "lit-html";
import { Grade } from "../types";
import { getAllReviews, getAllPerformances } from "../db";
import { loadCachedCards } from "../sync";
import { todayStr, retrievability } from "../fsrs";
import {
  LEECH_THRESHOLD,
  Leech,
  cardSummary,
  findLeeches,
  isRecovering,
} from "../leeches";
import { getConfig, getDesiredRetention } from "../github";
import { icon } from "./icons";
import { formatSyncAge } from "../sync-state";

export async function renderStats(
  container: HTMLElement,
  onBack: () => void
): Promise<void> {
  const [reviews, performances, cards] = await Promise.all([
    getAllReviews(),
    getAllPerformances(),
    loadCachedCards(),
  ]);
  const today = todayStr();

  const leeches = findLeeches(cards, reviews);

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

  // --- Upcoming forecast (today and the 13 days after: a fortnight) ---
  const forecast: { date: string; count: number }[] = [];
  for (let i = 0; i < 14; i++) {
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

  // Bars are scaled to the most common grade, so the largest one fills its track.
  const maxGrade = Math.max(
    1,
    gradeCounts.forgot,
    gradeCounts.hard,
    gradeCounts.good,
    gradeCounts.easy
  );

  const pct = (part: number, whole: number) =>
    `${((part / whole) * 100).toFixed(1)}%`;

  const target = getDesiredRetention();
  const forecastTotal = forecast.reduce((sum, f) => sum + f.count, 0);
  const maturity = (
    [
      ["new", "New", newCards],
      ["young", "Young", young],
      ["mature", "Mature", mature],
    ] as const
  ).filter(([kind, , count]) => count > 0 || (kind === "new" && learnedCards === 0));
  // The first fourteen weeks are only drawn where there is room for them.
  const oldWeeks = Math.max(0, weeks.length - 12);

  function paint(): void {
    render(
      html`<div class="page page-wide stats-view">
        <header class="page-head">
          <button
            id="back-btn"
            class="icon-btn"
            aria-label="Back"
            title="Back"
            @click=${onBack}
          >
            ${icon("back")}<span class="icon-btn-label">Today</span>
          </button>
          <h1>Statistics</h1>
        </header>

        <div class="tiles stats-overview">
          ${[
            [totalCards, "cards"],
            [learnedCards, "learned"],
            [dueToday, "due today"],
            [`${streak} day${streak === 1 ? "" : "s"}`, "streak"],
          ].map(
            ([value, label]) => html`<div class="panel stat-box">
              <div class="stat-value">${value}</div>
              <div class="stat-label">${label}</div>
            </div>`
          )}
        </div>

        <div class="stats-grid">
          <section class="panel retention">
            <div class="panel-head">
              <h2>Estimated retention</h2>
              <span>${`target ${Math.round(target * 100)}%`}</span>
            </div>
            <div class="big-number">
              ${retentions.length > 0 ? `${(avgRetention * 100).toFixed(1)}%` : "–"}
            </div>
            <div class="meter" role="img" aria-label="Estimated retention against the target">
              <div class="meter-fill" style="width: ${(avgRetention * 100).toFixed(1)}%"></div>
              <div class="meter-target" style="left: ${target * 100}%"></div>
            </div>
          </section>

          <section class="panel maturity">
            <div class="panel-head"><h2>Card maturity</h2></div>
            <div class="maturity-bar-container">
              ${maturity.map(
                ([kind, , count]) =>
                  html`<div
                    class="maturity-bar maturity-${kind}"
                    style="flex-grow: ${Math.max(1, count)}"
                  ></div>`
              )}
            </div>
            <div class="maturity-legend">
              ${(
                [
                  ["new", "New", newCards],
                  ["young", "Young", young],
                  ["mature", "Mature", mature],
                ] as const
              ).map(
                ([kind, label, count]) => html`<span class="legend-item">
                  <strong>${count}</strong>
                  <span class="legend-key"
                    ><span class="legend-dot maturity-${kind}"></span>${label}</span
                  >
                </span>`
              )}
            </div>
          </section>

          <section class="panel forecast">
            <div class="panel-head">
              <h2>Next 14 days</h2>
              <span>${`${forecastTotal} review${forecastTotal === 1 ? "" : "s"}`}</span>
            </div>
            <div class="forecast-chart" id="forecast">
              ${forecast.map(
                ({ date, count }, i) => html`<div
                  class="forecast-bar-wrapper"
                  title=${`${date}: ${count}`}
                >
                  <div class="forecast-bar-value">${count || ""}</div>
                  <div
                    class="forecast-bar ${i === 0 ? "is-today" : ""} ${count === 0
                      ? "is-zero"
                      : ""}"
                    style="--h: ${count / maxForecast}"
                  ></div>
                  <div class="forecast-bar-label">
                    ${date === today ? "Today" : weekday(date)}
                  </div>
                </div>`
              )}
            </div>
            <div class="forecast-axis" aria-hidden="true">
              <span>Today</span>
              <span>${shortDate(forecast[7].date)}</span>
              <span>${shortDate(forecast[13].date)}</span>
            </div>
          </section>

          <section class="panel grades-panel">
            <div class="panel-head">
              <h2>Grades, last 30 days</h2>
              <span>${`${gradeCounts.total} review${gradeCounts.total === 1 ? "" : "s"}`}</span>
            </div>
            ${gradeCounts.total > 0
              ? html`<div class="grade-bars">
                  ${(
                    [
                      ["Forgot", "forgot", gradeCounts.forgot],
                      ["Hard", "hard", gradeCounts.hard],
                      ["Good", "good", gradeCounts.good],
                      ["Easy", "easy", gradeCounts.easy],
                    ] as const
                  ).map(
                    ([label, kind, count]) => html`<div class="grade-row">
                      <span class="grade-label">${label}</span>
                      <div class="grade-bar-track">
                        <div
                          class="grade-bar grade-${kind}"
                          style="width: ${pct(count, maxGrade)}"
                        ></div>
                      </div>
                      <span class="grade-count">${count}</span>
                    </div>`
                  )}
                </div>`
              : html`<p class="stats-empty">No reviews in the last 30 days.</p>`}
          </section>

          <section class="panel activity">
            <div class="panel-head">
              <h2>Activity</h2>
              <span
                ><span class="narrow-only">last 12 weeks</span
                ><span class="wide-only">last 26 weeks</span></span
              >
            </div>
            <div class="heatmap-grid" id="heatmap">
              ${weeks.flatMap((week, w) =>
                week.map((day) => heatmapCell(day, w < oldWeeks))
              )}
            </div>
          </section>

          <section class="panel leeches">
            <div class="panel-head"><h2>Leeches</h2></div>
            ${renderLeeches(leeches, onEdit)}
          </section>
        </div>
      </div>`,
      container
    );
  }

  /**
   * Intensity is a class rather than an inline colour, so the palette can
   * follow the theme.
   */
  function heatmapCell(day: string, old: boolean): TemplateResult {
    const count = reviewsByDay.get(day) || 0;
    const level =
      day < startDate || day > today
        ? "empty"
        : count === 0
        ? 0
        : count / maxReviews < 0.25
        ? 1
        : count / maxReviews < 0.5
        ? 2
        : count / maxReviews < 0.75
        ? 3
        : 4;
    return html`<div
      class="heatmap-cell heat-${level} ${old ? "heat-old" : ""}"
      title=${`${day}: ${count} review${count === 1 ? "" : "s"}`}
    ></div>`;
  }

  // Rewriting the card is the only thing this list is for, so the row opens an
  // editor rather than handing the reader off to GitHub with the whole file.
  async function onEdit(leech: Leech): Promise<void> {
    const config = getConfig();
    if (!config) return;
    const { openCardEditor } = await import("./card-editor");
    const result = await openCardEditor(leech.card);
    // Repaint on a committed edit only: the counts, the list, and often whether
    // this card is on it at all have just changed.
    if (result) await renderStats(container, onBack);
  }

  paint();
}

// Local helpers
function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z");
  const db = new Date(b + "T00:00:00Z");
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

function weekday(date: string): string {
  return new Date(date + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short",
    timeZone: "UTC",
  });
}

function shortDate(date: string): string {
  return new Date(date + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}


/**
 * The cards worth rewriting, and a way to rewrite them.
 *
 * A list of failing cards with nothing to do about it is a list of things to
 * feel bad about, so every row opens the editor on the lines it came from.
 */
function renderLeeches(
  leeches: Leech[],
  onEdit: (leech: Leech) => void
): TemplateResult {
  if (leeches.length === 0) {
    return html`<p class="leech-empty">
      ${`Nothing has failed ${LEECH_THRESHOLD} or more times. ${caveat()}`}
    </p>`;
  }

  const struggling = leeches.filter((l) => !isRecovering(l));
  const recovered = leeches.length - struggling.length;
  // Recovered cards are still leeches by the count, but they are not what you
  // came here to rewrite. They get a line rather than a row.
  const shown = struggling.slice(0, MAX_LEECH_ROWS);
  const config = getConfig();

  const notes = [
    struggling.length > shown.length
      ? `${struggling.length - shown.length} more not shown.`
      : "",
    recovered > 0
      ? `${recovered} other${
          recovered === 1 ? " has" : "s have"
        } been answered correctly ${RECOVERED_RUN} times running since.`
      : "",
    caveat(),
  ].filter(Boolean);

  const lead =
    struggling.length === 1
      ? "One card keeps failing."
      : `These ${struggling.length} cards keep failing.`;

  return html`
    <p class="leech-intro">
      ${`${lead} A card that fails repeatedly is usually a badly written card rather than a hard fact — two questions in one, an ambiguous answer, nothing around a cloze to cue it.`}
    </p>
    <div class="list leech-list">
      ${shown.map((leech) => leechRow(leech, config !== null, onEdit))}
    </div>
    <p class="leech-note">${notes.join(" ")}</p>
  `;
}

const MAX_LEECH_ROWS = 10;
const RECOVERED_RUN = 3;

function caveat(): string {
  // Only performances cross devices; the review log is local, so lapse counts
  // are what this device has seen. Saying so beats quietly undercounting.
  return "Counted from reviews taken on this device.";
}

function leechRow(
  leech: Leech,
  editable: boolean,
  onEdit: (leech: Leech) => void
): TemplateResult {
  const rate = Math.round((leech.lapses / leech.reviews) * 100);
  const meta =
    `${leech.lapses} of ${leech.reviews} reviews failed (${rate}%)` +
    ` · last ${formatSyncAge(leech.lastLapseAt)}` +
    (leech.streak > 0 ? ` · ${leech.streak} right since` : "");
  return html`<div class="row leech-card">
    <div class="row-text leech-info">
      <span class="leech-text">${cardSummary(leech.card)}</span>
      <span class="leech-meta">${meta}</span>
    </div>
    ${editable
      ? html`<button
          class="btn btn-small leech-edit"
          type="button"
          @click=${() => void onEdit(leech)}
        >
          Edit
        </button>`
      : nothing}
  </div>`;
}
