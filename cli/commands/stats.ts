import { addDays } from "../../src/core/schedule";
import { EXIT } from "../command";
import type { Command } from "../command";
import { bar, percent, plural, table } from "../format";
import { describeSource } from "../history";
import {
  MATURE_DAYS,
  eventsByCard,
  forecast,
  predictedRetention,
  reviewsPerDay,
  streak,
  trueRetention,
} from "../insights";
import { activeCards, openWorkspace } from "../workspace";

export const stats: Command = {
  name: "stats",
  summary: "collection totals, maturity, retention, forecast, reviews per day",
  help: `Usage: hc stats [--date YYYY-MM-DD] [--days N]

  cards        totals by status; active cards by new / young / mature
               (mature: interval of ${MATURE_DAYS} days or more)
  retention    true retention (reviews of already-learned cards not graded
               Forgot), last 30 days and all time; predicted recall today
  forecast     reviews due on each of the next 14 days (overdue counted today)
  reviews      reviews per day over the last N days (default 14), streak

Options:
  --date <day>   evaluate as of this day; default: today
  --days <n>     days of review history to show (default 14)`,
  options: {
    date: { type: "string" },
    days: { type: "string" },
  },
  async run(ctx) {
    const { collection, history, states, today } = await openWorkspace(ctx);
    const config = collection.config.config;
    const active = activeCards(collection);
    const byCard = eventsByCard(history.events);
    const days = Math.max(1, Math.min(366, Number(ctx.values.days ?? 14) || 14));

    let young = 0;
    let mature = 0;
    for (const card of active) {
      const s = states.get(card.key);
      if (!s) continue;
      if (s.intervalDays >= MATURE_DAYS) mature++;
      else young++;
    }
    const count = (status: string) => collection.cards.filter((c) => c.status === status).length;
    const result = {
      date: today,
      history: history.source,
      cards: {
        total: collection.cards.length,
        active: active.length,
        draft: count("draft"),
        suspended: count("suspended"),
        new: active.length - young - mature,
        young,
        mature,
        decks: new Set(collection.cards.map((c) => c.deckName)).size,
        files: collection.files.length,
      },
      retention: {
        desired: config.review.desiredRetention,
        last30Days: trueRetention(byCard, addDays(today, -29)),
        allTime: trueRetention(byCard),
        predictedToday: predictedRetention(active, states, today),
      },
      forecast: forecast(active, states, today, 14),
      reviews: {
        total: history.events.filter((e) => e.kind === "review").length,
        streak: streak(history.events, today),
        perDay: reviewsPerDay(history.events, today, days),
      },
      warnings: history.warnings,
    };

    if (ctx.json) {
      ctx.emit(result);
      return EXIT.ok;
    }

    const c = result.cards;
    ctx.say(`${today}  ·  history: ${describeSource(history.source)}`);
    ctx.say(`\nCards  ${c.total} in ${plural(c.decks, "deck")} (${plural(c.files, "file")})`);
    ctx.say(
      table([
        ["active", String(c.active), `new ${c.new} · young ${c.young} · mature ${c.mature}`],
        ["draft", String(c.draft), c.draft > 0 ? "waiting in the Inbox" : ""],
        ["suspended", String(c.suspended), ""],
      ])
    );
    const r = result.retention;
    ctx.say(`\nRetention  (desired ${percent(r.desired)})`);
    ctx.say(
      table([
        ["last 30 days", percent(r.last30Days.rate), `${r.last30Days.passed}/${r.last30Days.reviews} reviews`],
        ["all time", percent(r.allTime.rate), `${r.allTime.passed}/${r.allTime.reviews} reviews`],
        ["predicted now", percent(r.predictedToday), "mean recall of reviewed cards today"],
      ])
    );
    const fmax = Math.max(...result.forecast.map((f) => f.due));
    ctx.say(`\nForecast  ${result.forecast.reduce((n, f) => n + f.due, 0)} reviews in 14 days`);
    ctx.say(table(result.forecast.map((f) => [f.date.slice(5), String(f.due), bar(f.due, fmax)])));
    const rmax = Math.max(...result.reviews.perDay.map((d) => d.reviews));
    ctx.say(`\nReviews  ${result.reviews.total} total · streak ${plural(result.reviews.streak, "day")}`);
    ctx.say(table(result.reviews.perDay.map((d) => [d.date.slice(5), String(d.reviews), bar(d.reviews, rmax)])));
    for (const w of history.warnings.slice(0, 5)) ctx.io.stderr(`warning: ${w}\n`);
    return EXIT.ok;
  },
};
