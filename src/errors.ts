export const EXIT = {
  OK: 0,
  FAILURE: 1,
  NOT_FOUND: 2,
  AMBIGUOUS: 3,
  LOCKED: 4,
  ASSOC_REJECTED: 5,
} as const;

export class KpxError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.FAILURE,
  ) {
    super(message);
    this.name = "KpxError";
  }
}
