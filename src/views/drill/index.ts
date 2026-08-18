import { Card } from "../../types";
import { attachKeyboard } from "./gestures";
import { createSession, SessionOptions } from "./session";
import { createView } from "./view";

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
  const session = await createSession(dueCards, options);
  const detachKeyboard = attachKeyboard(session);

  let leaving = false;
  async function finish(): Promise<void> {
    if (leaving) return;
    leaving = true;
    detachKeyboard();
    await session.close();
    onEnd();
  }

  const view = createView(container, session, () => void finish());
  session.onChange(() => view.paint());
  view.paint();
}
