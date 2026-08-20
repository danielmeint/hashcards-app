export enum Grade {
  Forgot = 1,
  Hard = 2,
  Good = 3,
  Easy = 4,
}

export type BasicCard = {
  type: "basic";
  question: string;
  answer: string;
};

export type ClozeCard = {
  type: "cloze";
  text: string;
  start: number;
  end: number;
};

export type CardContent = BasicCard | ClozeCard;

export type Card = {
  deckName: string;
  /**
   * `owner/repo` — which collection this card came out of. Stamped when cards
   * are read out of the deck store rather than stored on each one, so it cannot
   * drift from the file it actually belongs to; an edit needs it to know which
   * repository to commit to, and there may be more than one.
   */
  repo: string;
  filePath: string;
  /**
   * The lines of `filePath` this card was parsed from: absolute, 1-based and
   * inclusive, counting the frontmatter. That is what a `#L12-L18` link on
   * GitHub means by a line number, and what a person reading the file expects.
   */
  range: [number, number];
  content: CardContent;
  hash: string;
  familyHash: string | null;
};

/**
 * A card as the parser produces it: everything a file can say about a card, and
 * nothing about where the file came from. The parser reads a file; which
 * collection that file belongs to is not a question it can answer.
 */
export type ParsedCard = Omit<Card, "repo">;

export type NewPerformance = {
  type: "new";
};

export type ReviewedPerformance = {
  type: "reviewed";
  lastReviewedAt: string; // ISO date string
  stability: number;
  difficulty: number;
  intervalRaw: number;
  intervalDays: number;
  dueDate: string; // YYYY-MM-DD
  reviewCount: number;
};

export type Performance = NewPerformance | ReviewedPerformance;

export type Review = {
  cardHash: string;
  reviewedAt: string;
  grade: Grade;
  stability: number;
  difficulty: number;
  intervalRaw: number;
  intervalDays: number;
  dueDate: string;
};

/**
 * A drill in progress, persisted alongside each grade so an interrupted session
 * can be picked up where it left off. Cards are stored as hashes and rehydrated
 * from the cached card set; a card that has since vanished from the repo is
 * dropped on resume.
 *
 * `revealed` is deliberately not persisted — resuming should show the front of
 * the card, not hand back an answer that was already on screen.
 */
export type DrillSession = {
  /** Remaining cards, in queue order. */
  queue: string[];
  /** Cards in reinforcement (graded Forgot or Hard, awaiting "Got it"). */
  requeued: string[];
  /** Cards retired from the queue. */
  completed: string[];
  /** New cards already charged against today's budget this session. */
  gradedNew: string[];
  /** Queue size at session start, for the progress bar. */
  totalCards: number;
  startedAt: string;
};
