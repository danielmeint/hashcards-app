import { Card } from "../../types";
import { attachKeyboard } from "./gestures";
import { createSession, SessionOptions } from "./session";
import { createView } from "./view";
import { loadMarkdown } from "../../render";
import { warmTypesetting } from "../../typeset";
import { getConfig } from "../../github";

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

  // Demo cards are in no repo at all, and a drill without a configured one has
  // nowhere to send an edit — in both cases the button would be a promise the
  // app cannot keep, so it is not offered, by button or by key.
  const repo = options.dryRun ? null : getConfig();

  let leaving = false;
  let editing = false;

  async function edit(): Promise<void> {
    const card = session.current;
    if (editing || leaving || !card || !repo) return;
    editing = true;
    // The sheet ignores keys typed into its own textarea, but a stray Space
    // with focus anywhere else would reveal — or grade — the card sitting
    // behind it. The drill's shortcuts go away for as long as it is open.
    detachKeyboard();
    try {
      const { openCardEditor } = await import("../card-editor");
      const result = await openCardEditor(card, repo);
      if (result) {
        session.replaceCard(card.hash, result.card, result.keptScheduling);
      }
    } finally {
      editing = false;
      if (!leaving) detachKeyboard = attachKeyboard(session, keyActions);
    }
  }

  const keyActions = { onEdit: repo ? () => void edit() : undefined };
  let detachKeyboard = attachKeyboard(session, keyActions);

  async function finish(): Promise<void> {
    if (leaving) return;
    leaving = true;
    detachKeyboard();
    await session.close();
    onEnd();
  }

  const view = createView(container, session, () => void finish(), {
    onEdit: keyActions.onEdit,
  });
  session.onChange(() => view.paint());
  view.paint();
}
