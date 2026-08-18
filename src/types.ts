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
  filePath: string;
  range: [number, number];
  content: CardContent;
  hash: string;
  familyHash: string | null;
};

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
