/**
 * An engine account's own usage limits, as the engine reports them (not greyfolk's: greyverse sets
 * no limits of its own). Times are Unix seconds.
 */
export interface LimitWindow {
  /** The engine's name for the window: "five_hour", "seven_day", "weekly", … */
  name: string;
  used_percent: number | null;
  resets_at: number | null;
  window_minutes?: number | null;
}

export interface Limits {
  engine: string;
  plan?: string | null;
  /** The account cannot be used now (a limit is reached). */
  blocked: boolean;
  windows: LimitWindow[];
  /** Resets the account holds (Codex): how many, and when each expires (null: never). */
  reset_credits?: { count: number; expires_at: (number | null)[] } | null;
  /** When the engine last said so. */
  observed_at: number;
}
