// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { legacy, settings } from "./settings";

describe("settings", () => {
  beforeEach(() => localStorage.clear());

  it("answers with the default when nothing is stored", () => {
    expect(settings.repos.get()).toEqual([]);
    expect(settings.newCardsPerDay.get()).toBe(20);
    expect(settings.intervalFuzz.get()).toBe(true);
    expect(settings.hapticFeedback.get()).toBe(true);
    expect(settings.theme.get()).toBe("system");
    expect(settings.lastPushedAt.get()).toBeNull();
    expect(settings.introducedToday.get()).toBeNull();
  });

  it("keeps the keys the app already has in the field", () => {
    // Renaming any of these silently resets that setting for every install.
    legacy.owner.set("daniel");
    settings.newCardsPerDay.set(30);
    settings.intervalFuzz.set(false);
    expect(localStorage.getItem("github_owner")).toBe("daniel");
    expect(localStorage.getItem("new_cards_per_day")).toBe("30");
    expect(localStorage.getItem("interval_fuzz")).toBe("false");
  });

  it("round-trips every type it stores", () => {
    settings.newCardsPerDay.set(5);
    settings.hapticFeedback.set(false);
    settings.introducedToday.set({ date: "2026-08-19", count: 3 });
    settings.lastSyncedAt.set("2026-08-19T09:00:00.000Z");

    expect(settings.newCardsPerDay.get()).toBe(5);
    expect(settings.hapticFeedback.get()).toBe(false);
    expect(settings.introducedToday.get()).toEqual({
      date: "2026-08-19",
      count: 3,
    });
    expect(settings.lastSyncedAt.get()).toBe("2026-08-19T09:00:00.000Z");
  });

  it("stores no choice at all for the theme that is not a choice", () => {
    settings.theme.set("dark");
    expect(localStorage.getItem("theme")).toBe("dark");

    settings.theme.set("system");
    // Leaving "system" written down would override an OS preference that
    // changes later, which is the opposite of what following the system means.
    expect(localStorage.getItem("theme")).toBeNull();
    expect(settings.theme.get()).toBe("system");
  });

  it("falls back rather than propagating a corrupt value", () => {
    localStorage.setItem("new_cards_per_day", "twenty");
    localStorage.setItem("new_cards_introduced", "{not json");
    localStorage.setItem("theme", "chartreuse");

    // This used to parse to NaN and travel: `remainingBudget` became NaN, and
    // the deck list offered no new cards at all without ever saying why.
    expect(settings.newCardsPerDay.get()).toBe(20);
    expect(settings.introducedToday.get()).toBeNull();
    expect(settings.theme.get()).toBe("system");
  });

  it("reads a flag as on unless it is exactly off", () => {
    localStorage.setItem("interval_fuzz", "");
    expect(settings.intervalFuzz.get()).toBe(true);
    localStorage.setItem("interval_fuzz", "false");
    expect(settings.intervalFuzz.get()).toBe(false);
  });

  it("names the keys it is in the middle of leaving behind", () => {
    localStorage.setItem("github_pat", "ghp_xxx");
    localStorage.setItem("cached_cards", "[]");
    expect(legacy.pat.get()).toBe("ghp_xxx");
    expect(legacy.cards.get()).toBe("[]");

    legacy.pat.remove();
    expect(localStorage.getItem("github_pat")).toBeNull();
  });
});
