/**
 * The AI coordinator.
 *
 * Three jobs, all of them things a human treasurer does badly at 11pm: nudge people in the language
 * they actually read, spot a round that looks wrong before money moves, and explain a member's
 * savings record in a sentence.
 *
 * The model never touches money. It cannot pay an invoice, settle a round, or change a rule: it
 * reads the circle's public state and writes text. If no API key is set, every function here still
 * answers, from templates and rules.
 */

import type { Circle } from './circle.ts';
import { owedSats, roundDeadline } from './circle.ts';
import type { Stats } from './reputation.ts';
import { explain, score } from './reputation.ts';

export type Lang = 'fr' | 'en' | 'wo';
export const LANGS: Lang[] = ['fr', 'en', 'wo'];

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as string[]).includes(value);
}

type AiConfig = { apiKey: string; baseUrl: string; model: string };

function config(): AiConfig | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.OPENAI_BASE_URL?.trim() || 'https://freebuff.com/api/v1/paid').replace(/\/$/, ''),
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
  };
}

export function aiEnabled(): boolean {
  return config() !== null;
}

/** One short completion. Returns null on any failure so callers fall back instead of erroring. */
async function complete(system: string, user: string, maxTokens = 220): Promise<string | null> {
  const cfg = config();
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text.slice(0, 600) : null;
  } catch {
    return null;
  }
}

const SATS = (n: number) => n.toLocaleString('en-US');

function timeLeft(seconds: number): { en: string; fr: string; wo: string } {
  if (seconds <= 0) return { en: 'now', fr: "maintenant", wo: 'léegi' };
  if (seconds < 3600) {
    const m = Math.max(1, Math.round(seconds / 60));
    return { en: `${m} minutes`, fr: `${m} minutes`, wo: `${m} simili` };
  }
  if (seconds < 86400) {
    const h = Math.round(seconds / 3600);
    return { en: `${h} hours`, fr: `${h} heures`, wo: `${h} waxtu` };
  }
  const d = Math.round(seconds / 86400);
  return { en: `${d} days`, fr: `${d} jours`, wo: `${d} fan` };
}

/**
 * Templates are the floor, not a placeholder: they are what a member sees when the network is slow
 * or no key is configured. Wolof wording should be checked by a native speaker before a public run.
 */
export function templateReminder(input: {
  circleName: string;
  contributionSats: number;
  round: number;
  secondsLeft: number;
  lang: Lang;
  score: number;
}): string {
  const t = timeLeft(input.secondsLeft);
  const amount = SATS(input.contributionSats);
  if (input.lang === 'fr') {
    return `Rappel : ${amount} sats pour « ${input.circleName} », tour ${input.round}. Il reste ${t.fr}. Le pot se partage entre celles et ceux qui ont payé à temps.`;
  }
  if (input.lang === 'wo') {
    return `Fàttali : ${amount} sats ci « ${input.circleName} », tour ${input.round}. ${t.wo} mooy des. Ku fey ci waxtu, ñu koy jox alal bi.`;
  }
  return `Reminder: ${amount} sats for "${input.circleName}", round ${input.round}. ${t.en} left. The pot goes to everyone who paid on time.`;
}

export type ReminderResult = { text: string; source: 'ai' | 'template'; lang: Lang };

/** A payment nudge in the member's language, honouring their savings record. */
export async function reminder(
  circle: Circle,
  npub: string,
  lang: Lang,
  now: number,
): Promise<ReminderResult> {
  const stats = { onTime: 0, missed: 0 } as { onTime: number; missed: number };
  const m = circle.members.find((x) => x.npub === npub);
  if (m) {
    stats.onTime = m.onTime;
    stats.missed = m.missed;
  }
  const secondsLeft = roundDeadline(circle, circle.currentRound) - now;
  const base = {
    circleName: circle.name,
    contributionSats: circle.config.contributionSats,
    round: circle.currentRound,
    secondsLeft,
    lang,
    score: 500 + stats.onTime * 10 - stats.missed * 35,
  };

  const fallback = templateReminder(base);
  const ai = await complete(
    'You write one short payment reminder for a rotating savings circle (tontine) in West Africa. ' +
      'Plain language, no jargon, no emoji, at most 45 words. Never invent amounts or rules. ' +
      'Reply with the message only.',
    `Language: ${lang}. Circle: ${base.circleName}. Each member pays ${base.contributionSats} sats per round. ` +
      `This is round ${base.round} of ${circle.config.size}. Time left: ${secondsLeft > 0 ? secondsLeft + ' seconds' : 'past due'}. ` +
      `The member has paid on time ${stats.onTime} times and missed ${stats.missed}.`,
  );
  return ai ? { text: ai, source: 'ai', lang } : { text: fallback, source: 'template', lang };
}

export type Flag = { code: string; severity: 'info' | 'warn'; text: string };

/**
 * Rules that catch a round worth a second look before settlement. Deliberately deterministic: a
 * payment anomaly should not depend on a model's mood.
 */
export function flagRound(circle: Circle, now: number): Flag[] {
  const flags: Flag[] = [];
  const round = circle.currentRound;
  const pot = circle.config.contributionSats * circle.config.size;
  const collected = circle.collected[String(round)] ?? 0;
  const topDiscount = circle.topDiscount[String(round)] ?? 0;
  const topBidder = circle.topBidder[String(round)] ?? null;

  if (circle.phase !== 'active') return flags;

  const deadline = roundDeadline(circle, round);
  if (now > deadline) {
    flags.push({ code: 'overdue', severity: 'info', text: 'the round is past its deadline and can be settled' });
  }
  const unpaid = circle.members.filter(
    (m) => !m.defaulted && !(circle.paid[String(round)] ?? []).includes(m.npub),
  );
  if (unpaid.length > 0) {
    flags.push({
      code: 'unpaid',
      severity: unpaid.length * 2 >= circle.config.size ? 'warn' : 'info',
      text: `${unpaid.length} member${unpaid.length === 1 ? '' : 's'} still to pay this round`,
    });
  }
  if (topBidder && pot > 0 && topDiscount / pot > 0.2) {
    flags.push({
      code: 'steep_discount',
      severity: 'warn',
      text: `the top bid gives away ${Math.round((topDiscount / pot) * 100)}% of the pot to take it early`,
    });
  }
  if (collected > 0 && collected < pot) {
    flags.push({
      code: 'partial_pot',
      severity: 'info',
      text: `only ${SATS(collected)} of ${SATS(pot)} sats are in so far; the rest comes from collateral when the round closes`,
    });
  }
  if (circle.members.some((m) => m.defaulted)) {
    flags.push({ code: 'defaulted', severity: 'warn', text: 'a member has defaulted in this circle' });
  }
  return flags;
}

/** A plain-language health check of the whole circle, for the person running it. */
export async function briefing(circle: Circle, now: number): Promise<{ text: string; source: 'ai' | 'template' }> {
  const flags = flagRound(circle, now);
  const owed = circle.members.reduce((sum, m) => sum + owedSats(circle, m.npub), 0);
  const fallback =
    circle.phase === 'forming'
      ? `${circle.members.length} of ${circle.config.size} seats are filled. The circle starts when the last one joins.`
      : circle.phase === 'completed'
        ? `All ${circle.config.size} rounds are paid out. ${SATS(owed)} sats are still waiting to be claimed.`
        : `Round ${circle.currentRound} of ${circle.config.size}. ${flags.length > 0 ? flags.map((f) => f.text).join('; ') : 'everything is on track'}.`;

  const ai = await complete(
    'You are the coordinator of a rotating savings circle. Summarise its state in at most 50 words, ' +
      'plain words, no advice about investing, no invented numbers. Reply with the summary only.',
    `Circle ${circle.name}, phase ${circle.phase}, round ${circle.currentRound} of ${circle.config.size}, ` +
      `${circle.members.length} members, each pays ${circle.config.contributionSats} sats. Signals: ` +
      `${flags.map((f) => f.text).join('; ') || 'none'}. Still owed to members: ${owed} sats.`,
  );
  return ai ? { text: ai, source: 'ai' } : { text: fallback, source: 'template' };
}

/** One sentence about a member's savings record, with the numbers as the source of truth. */
export async function memberNote(npubs: string, stats: Stats): Promise<{ text: string; source: 'ai' | 'template' }> {
  const notes = explain(stats);
  const fallback = `Savings score ${score(stats)} of 1000: ${notes.join(', ') || 'no history'}.`;
  const ai = await complete(
    'Explain a member savings record in one neutral sentence of at most 30 words. Do not add facts. Reply with the sentence only.',
    `Score ${score(stats)} of 1000. Completed circles: ${stats.circlesCompleted}. Defaults: ${stats.circlesDefaulted}. ` +
      `On-time payments: ${stats.onTimePayments}. Missed: ${stats.missedPayments}. Total contributed: ${stats.totalContributedSats} sats.`,
    120,
  );
  return ai ? { text: ai, source: 'ai' } : { text: fallback, source: 'template' };
}
