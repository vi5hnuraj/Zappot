/**
 * The portable savings record, computed from finished circles.
 *
 * A transparent 0–1000 score, so a member who saved with Zappot can show a portable history. Any
 * lender, merchant or future circle can read it from `GET /api/reputation/:npub`.
 */

import type { Circle } from './circle.ts';

export type Stats = {
  circlesCompleted: number;
  circlesDefaulted: number;
  onTimePayments: number;
  missedPayments: number;
  totalContributedSats: number;
  lastUpdated: number;
};

export function statsFor(circles: Circle[], npub: string): Stats {
  const stats: Stats = {
    circlesCompleted: 0,
    circlesDefaulted: 0,
    onTimePayments: 0,
    missedPayments: 0,
    totalContributedSats: 0,
    lastUpdated: 0,
  };

  for (const circle of circles) {
    // Only a circle that ran to the end says anything about a member.
    if (circle.phase !== 'completed') continue;
    const m = circle.members.find((x) => x.npub === npub);
    if (!m) continue;
    if (m.defaulted) stats.circlesDefaulted += 1;
    else stats.circlesCompleted += 1;
    stats.onTimePayments += m.onTime;
    stats.missedPayments += m.missed;
    stats.totalContributedSats += m.contributed;
    stats.lastUpdated = Math.max(stats.lastUpdated, circle.results.at(-1)?.settledAt ?? circle.startedAt);
  }
  return stats;
}

/** Starts at 500, rises with on-time payments and completed circles, falls with misses and defaults. */
export function score(stats: Stats): number {
  const raw =
    500 +
    stats.onTimePayments * 10 +
    stats.circlesCompleted * 40 -
    stats.missedPayments * 35 -
    stats.circlesDefaulted * 200;
  return Math.max(0, Math.min(1000, raw));
}

export function explain(stats: Stats): string[] {
  const notes: string[] = [];
  if (stats.circlesCompleted === 0 && stats.circlesDefaulted === 0) notes.push('no finished circle yet');
  if (stats.circlesCompleted > 0) {
    notes.push(`${stats.circlesCompleted} circle${stats.circlesCompleted === 1 ? '' : 's'} completed`);
  }
  if (stats.onTimePayments > 0) notes.push(`${stats.onTimePayments} on-time payment${stats.onTimePayments === 1 ? '' : 's'}`);
  if (stats.missedPayments > 0) notes.push(`${stats.missedPayments} missed`);
  if (stats.circlesDefaulted > 0) notes.push(`${stats.circlesDefaulted} default${stats.circlesDefaulted === 1 ? '' : 's'}`);
  return notes;
}
