import { Card } from "../../types";
import { attachKeyboard } from "./gestures";
import { createSession, SessionOptions } from "./session";
import { createView } from "./view";
import { loadMarkdown } from "../../render";
import { warmTypesetting } from "../../typeset";

export type { SessionOptions as DrillOptions };

/**
 * Wires the three halves of a drill together in one direction: input mutates
 * the session, the session announces that it changed, and the view repaints.
 * Nothing calls back the other way.
 */
export async function renderDrill(
  container: HTMLElement,
  dueCards: Card[],
  onEnd: () => void,
  options: SessionOptions = {}
): Promise<void> {
  // What this session will need, started now rather than when the card that
  // needs it appears. Startup warms this too, but not on the first run of a
  // fresh install: there are no cached cards to look at yet.
  warmTypesetting(dueCards);

  // Markdown is not in the initial bundle; a drill is the only thing that
  // needs it, and this is the last await before the first card is drawn.
  const [session] = await Promise.all([
    createSession(dueCards, options),
    loadMarkdown(),
  ]);
  const detachKeyboard = attachKeyboard(session);

  let leaving = false;
  async function finish(): Promise<void> {
    if (leaving) return;
    leaving = true;
    detachKeyboard();
    await session.close();
    onEnd();
  }

  const view = createView(container, session, () => void finish(), {
    sourceLinks: !options.dryRun,
  });
  session.onChange(() => view.paint());
  view.paint();
}
