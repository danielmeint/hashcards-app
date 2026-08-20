import { Grade } from "../../types";
import { haptic } from "../../haptics";
import { Session } from "./session";

/**
 * Input for the drill. The keyboard is the desktop story; the card itself is
 * the mobile one — on a phone the controls are a row of small targets along the
 * bottom edge while the card is the whole screen.
 */

/**
 * How far a drag must travel horizontally before it counts as a swipe.
 *
 * Deliberately below the browser's own pan slop. Two things decide what a
 * gesture is, and the browser goes first: with `touch-action: pan-y` it watches
 * the opening movement, and the moment it reads a vertical pan it takes the
 * pointer and sends `pointercancel`. Nothing arrives after that — no further
 * `pointermove` for that finger — so the swipe is not lost, it is *gone*, and
 * no amount of horizontal travel afterwards can bring it back.
 *
 * At 12px this threshold guaranteed we were second: a thumb 30° off horizontal
 * has moved 5px vertically by the time it has moved 9px sideways, which is
 * enough for the browser to have started scrolling while we were still waiting
 * to be sure.
 */
const SWIPE_CLAIM_PX = 8;

/**
 * How far off horizontal a swipe may lean, as a slope — `|dy|` over `|dx|`.
 *
 * A thumb pivots at its base, so a swipe someone means as horizontal arrives as
 * an arc: steep at the start, flattening as it goes. Measured from the touch
 * origin, the early steep part keeps `dy` inflated long after the finger is
 * plainly moving sideways. The old rule was `|dx| > |dy|` — a 45° cone, which
 * is narrower than a thumb is accurate.
 *
 * Widening it is safe because this test is not what protects scrolling. The
 * browser arbitrates first, and a gesture it read as a vertical pan never
 * reaches here at all; what this sorts is only what the browser has already
 * declined to scroll.
 */
const SWIPE_CONE = 1.6; // ≈58° off horizontal

/** How far it must travel before releasing commits, rather than springing back. */
const SWIPE_COMMIT_PX = 90;

type Drag = {
  id: number;
  x0: number;
  y0: number;
  dx: number;
  /** Set once the gesture is unambiguously horizontal and we own it. */
  claimed: boolean;
  /** Set once it has passed the commit distance, for a single haptic tick. */
  armed: boolean;
};

/** What a release in this direction would do, for the drag indicator. */
function swipeAction(
  session: Session,
  right: boolean
): { label: string; positive: boolean } {
  if (!session.revealed) return { label: "Reveal", positive: true };
  if (session.requeued) {
    return right
      ? { label: "Got it", positive: true }
      : { label: "Again", positive: false };
  }
  return right
    ? { label: "Good", positive: true }
    : { label: "Forgot", positive: false };
}

function commitSwipe(session: Session, right: boolean): void {
  // A swipe before the answer is showing means "show me", never a grade — the
  // gesture must not be able to grade a card that was never seen.
  if (!session.revealed) {
    session.reveal();
    return;
  }
  if (session.requeued) session.requeue(!right);
  else session.grade(right ? Grade.Good : Grade.Forgot);
}

export function attachCardGestures(
  cardContainer: HTMLElement,
  swipeHint: HTMLElement,
  session: Session
): void {
  const currentCard = () =>
    cardContainer.querySelector(".card") as HTMLElement | null;

  let drag: Drag | null = null;
  /** A completed swipe also produces a click; that click is not a tap. */
  let swipeAteClick = false;

  cardContainer.addEventListener("click", (e) => {
    if (swipeAteClick || session.revealed) return;
    // Links keep their own behaviour, and the click that ends a text selection
    // is someone reading, not someone asking for the answer.
    if ((e.target as HTMLElement).closest?.("a")) return;
    if (document.getSelection()?.isCollapsed === false) return;
    session.reveal();
  });

  cardContainer.addEventListener("pointerdown", (e) => {
    // Mouse drags are text selection, and desktop has the keyboard.
    if (e.pointerType === "mouse" || session.finished) return;
    drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      dx: 0,
      claimed: false,
      armed: false,
    };
  });

  cardContainer.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;

    if (!drag.claimed) {
      // Re-tested on every move, so a gesture that opened steep and flattened
      // out can still be claimed — the arc is the normal shape of a thumb
      // swipe, not an edge case.
      if (Math.abs(dx) < SWIPE_CLAIM_PX) return;
      if (Math.abs(dy) > Math.abs(dx) * SWIPE_CONE) return;
      drag.claimed = true;
      cardContainer.setPointerCapture?.(e.pointerId);
    }

    e.preventDefault();
    drag.dx = dx;

    const progress = Math.min(1, Math.abs(dx) / SWIPE_COMMIT_PX);
    if (progress === 1 && !drag.armed) {
      drag.armed = true;
      haptic(8);
    } else if (progress < 1) {
      drag.armed = false;
    }

    const node = currentCard();
    if (node) {
      // A little tilt reads as "picking the card up". Clamped, because a long
      // drag on a wide card otherwise turns into a cartwheel.
      const tilt = Math.max(-3, Math.min(3, dx * 0.02));
      node.style.transition = "none";
      node.style.transform = `translateX(${dx}px) rotate(${tilt}deg)`;
    }

    const action = swipeAction(session, dx > 0);
    swipeHint.textContent = action.label;
    swipeHint.classList.toggle("swipe-hint-positive", action.positive);
    swipeHint.style.opacity = String(progress);
    swipeHint.hidden = false;
  });

  const endDrag = (e: PointerEvent, commit: boolean) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dx, claimed } = drag;
    drag = null;

    const node = currentCard();
    if (node) {
      node.style.transition = "transform 0.2s ease";
      node.style.transform = "";
    }
    swipeHint.hidden = true;
    swipeHint.style.opacity = "0";

    if (!claimed) return;
    // The synthetic click that follows a drag belongs to the gesture.
    swipeAteClick = true;
    setTimeout(() => {
      swipeAteClick = false;
    }, 0);

    if (commit && Math.abs(dx) >= SWIPE_COMMIT_PX) commitSwipe(session, dx > 0);
  };

  cardContainer.addEventListener("pointerup", (e) => endDrag(e, true));
  // A cancel is almost always the browser taking the gesture for a scroll. It
  // is not recoverable — the pointer is finished and nothing further will be
  // reported for it — so all this can do is put the card back. What keeps that
  // from happening in the first place is `touch-action`: the container concedes
  // vertical panning only while the card has somewhere to scroll to, and a card
  // that fits on screen concedes nothing.
  cardContainer.addEventListener("pointercancel", (e) => endDrag(e, false));
}

/** Keyboard shortcuts, on the document. Returns a teardown. */
export function attachKeyboard(
  session: Session,
  actions: { onEdit?: () => void } = {}
): () => void {
  const controller = new AbortController();

  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const requeued = session.requeued;

      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        session.reveal(); // Reveal, and only ever reveal
      } else if (
        session.revealed &&
        requeued &&
        (e.key === "Enter" || e.key === "2")
      ) {
        session.requeue(false); // Enter or 2 = Got it
      } else if (session.revealed && requeued && e.key === "1") {
        session.requeue(true); // 1 = Again
      } else if (
        session.revealed &&
        !requeued &&
        e.key >= "1" &&
        e.key <= "4"
      ) {
        session.grade(parseInt(e.key) as Grade);
      } else if (e.key === "u" || e.key === "U") {
        void session.undo();
      } else if ((e.key === "e" || e.key === "E") && actions.onEdit) {
        // Noticing the card is wrong is the moment to fix it, and reaching for
        // the mouse is where that intention goes to die.
        e.preventDefault();
        actions.onEdit();
      }
    },
    { signal: controller.signal }
  );

  return () => controller.abort();
}
