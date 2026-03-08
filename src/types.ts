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
