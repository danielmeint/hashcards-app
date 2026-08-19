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
import { getConfig } from "../github";
import { openCardEditor } from "./card-editor";
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

  const pct = (part: number, whole: number) =>
    `${((part / whole) * 100).toFixed(1)}%`;

  function paint(): void {
    render(
      html`<div class="stats-view">
        <div class="stats-header">
          <button id="back-btn" class="btn stats-back-btn" @click=${onBack}>
            Back
          </button>
          <h1>Statistics</h1>
        </div>

        <div class="stats-overview">
          ${[
            [totalCards, "Total cards"],
            [learnedCards, "Learned"],
            [dueToday, "Due today"],
            [`${streak}d`, "Streak"],
          ].map(
            ([value, label]) => html`<div class="stat-box">
              <div class="stat-value">${value}</div>
              <div class="stat-label">${label}</div>
            </div>`
          )}
        </div>

        <div class="stats-section">
          <h2>Leeches</h2>
          ${renderLeeches(leeches, onEdit)}
        </div>

        <div class="stats-section">
          <h2>Estimated Retention</h2>
          <div class="retention-bar-container">
            <div
              class="retention-bar"
              style="width: ${(avgRetention * 100).toFixed(0)}%"
            ></div>
            <span class="retention-label"
              >${`${(avgRetention * 100).toFixed(1)}%`}</span
            >
          </div>
        </div>

        <div class="stats-section">
          <h2>Card Maturity</h2>
          <div class="maturity-bar-container">
            ${learnedCards > 0
              ? html`
                  <div
                    class="maturity-bar maturity-new"
                    style="width: ${pct(newCards, totalCards)}"
                  ></div>
                  <div
                    class="maturity-bar maturity-young"
                    style="width: ${pct(young, totalCards)}"
                  ></div>
                  <div
                    class="maturity-bar maturity-mature"
                    style="width: ${pct(mature, totalCards)}"
                  ></div>
                `
              : html`<div
                  class="maturity-bar maturity-new"
                  style="width: 100%"
                ></div>`}
          </div>
          <div class="maturity-legend">
            ${[
              ["new", "New", newCards],
              ["young", "Young", young],
              ["mature", "Mature", mature],
            ].map(
              ([kind, label, count]) => html`<span class="legend-item"
                ><span class="legend-dot maturity-${kind}-dot"></span>
                ${`${label} (${count})`}</span
              >`
            )}
          </div>
        </div>

        <div class="stats-section">
          <h2>Review Heatmap</h2>
          <div class="heatmap-container">
            <div class="heatmap-grid" id="heatmap">
              ${weeks.map(
                (week) => html`<div class="heatmap-col">
                  ${week.map((day) => heatmapCell(day))}
                </div>`
              )}
            </div>
            <div class="heatmap-legend">
              <span>Less</span>
              ${[0, 1, 2, 3, 4].map(
                (level) => html`<span class="heatmap-cell heat-${level}"></span>`
              )}
              <span>More</span>
            </div>
          </div>
        </div>

        <div class="stats-section">
          <h2>Grades (Last 30 Days)</h2>
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
                        style="width: ${pct(count, gradeCounts.total)}"
                      ></div>
                    </div>
                    <span class="grade-count">${count}</span>
                  </div>`
                )}
              </div>`
            : html`<div class="stats-empty">
                No reviews in the last 30 days.
              </div>`}
        </div>

        <div class="stats-section">
          <h2>Upcoming Reviews</h2>
          <div class="forecast-chart" id="forecast">
            ${forecast.map(
              ({ date, count }) => html`<div class="forecast-bar-wrapper">
                <div class="forecast-bar-value">${count || ""}</div>
                <div
                  class="forecast-bar"
                  style="height: ${(count / maxForecast) * 100}%"
                ></div>
                <div class="forecast-bar-label">
                  ${date === today ? "Today" : date.slice(5)}
                </div>
              </div>`
            )}
          </div>
        </div>
      </div>`,
      container
    );
  }

  /**
   * Intensity is a class rather than an inline colour, so the palette can
   * follow the theme.
   */
  function heatmapCell(day: string): TemplateResult {
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
      class="heatmap-cell heat-${level}"
      title=${`${day}: ${count} review${count === 1 ? "" : "s"}`}
    ></div>`;
  }

  // Rewriting the card is the only thing this list is for, so the row opens an
  // editor rather than handing the reader off to GitHub with the whole file.
  async function onEdit(leech: Leech): Promise<void> {
    const config = getConfig();
    if (!config) return;
    const result = await openCardEditor(leech.card, config);
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
    <div class="leech-list">
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
  return html`<div class="leech-card">
    <div class="leech-info">
      <span class="leech-text">${cardSummary(leech.card)}</span>
      <span class="leech-meta">${meta}</span>
    </div>
    ${editable
      ? html`<button
          class="btn leech-edit"
          type="button"
          @click=${() => void onEdit(leech)}
        >
          Edit
        </button>`
      : nothing}
  </div>`;
}
