import { prisma } from '../db/prisma.js';
import * as activityRepo from '../repositories/activity.repository.js';
import * as srsRepo from '../repositories/srs.repository.js';
import * as deckStatsRepo from '../repositories/deck-stats.repository.js';
import * as sessionsRepo from '../repositories/sessions.repository.js';
import { buildStats } from '../shared/mappers.deck.js';
import {
    DEFAULT_TZ,
    computeStreak,
    dateToDayKey,
    dayKeyToDate,
    tzDayKey,
    tzDayKeysEndingOn,
    tzWindowLowerBoundUtc,
} from './tz.js';
import type { StatsRange } from '../schemas/stats.schema.js';

// 'all' has no fixed window; per-day series mirror getSeries and cap 'all' at
// 365 points so the x-axis stays bounded.
const ALL_RANGE_SERIES_DAYS = 365;

const rangeDays = (range: StatsRange): number | null => (range === 'all' ? null : Number(range));

// ---------- Overview ----------
//
// Every per-day figure here is keyed by the viewer's LOCAL calendar day (tz):
// DailyActivity rows are written under the reviewer's local day (see
// activity.repository recordReview), and "today", the range windows and the
// streak are all computed in the same zone. Pass 'UTC' for the old behaviour.

export type StatsOverview = {
    range: StatsRange;
    reviewed: number;
    correct: number;
    retention: number; // 0..100, rounded
    streak: number; // current consecutive-day streak ending today (viewer's local day)
    dueCount: number;
    trends: {
        // deltaPct is null when there is no comparison window: range 'all' has
        // no "previous" period by construction, so any percentage there would
        // be fabricated (it always came out as +100%).
        reviewed: { current: number; previous: number; deltaPct: number | null };
        retention: { current: number; previous: number; deltaPct: number | null };
    };
};

const aggregateRange = (rows: { reviews: number; correct: number }[]) =>
    rows.reduce(
        (acc, r) => {
            acc.reviewed += r.reviews;
            acc.correct += r.correct;
            return acc;
        },
        { reviewed: 0, correct: 0 },
    );

const pctChange = (current: number, previous: number): number => {
    if (previous === 0) {
        return current > 0 ? 100 : 0;
    }
    return Math.round(((current - previous) / previous) * 100);
};

// The inclusive @db.Date bounds [first, last] of a window of local day keys,
// for a DailyActivity range query. Every window here is non-empty (range days
// are 7/30/90/365), so the throw only guards that invariant.
const dayWindowBounds = (keys: string[]): [Date, Date] => {
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (first === undefined || last === undefined) {
        throw new RangeError('dayWindowBounds: empty day-key window');
    }
    return [dayKeyToDate(first), dayKeyToDate(last)];
};

// Pure: the current and previous `days`-long windows of local day keys.
export const overviewWindows = (
    now: Date,
    tz: string,
    days: number,
): { current: string[]; previous: string[] } => {
    const keys = tzDayKeysEndingOn(now, tz, days * 2);
    return { previous: keys.slice(0, days), current: keys.slice(days) };
};

export const overview = async (
    userId: string,
    range: StatsRange,
    tz: string = DEFAULT_TZ,
): Promise<StatsOverview> => {
    const now = new Date();
    const days = rangeDays(range);

    let currentRows: Awaited<ReturnType<typeof activityRepo.rangeDays>>;
    let previousRows: typeof currentRows = [];

    if (days === null) {
        currentRows = await activityRepo.allDays(userId);
    } else {
        const { current, previous } = overviewWindows(now, tz, days);
        const [currentFrom, currentTo] = dayWindowBounds(current);
        const [previousFrom, previousTo] = dayWindowBounds(previous);
        [currentRows, previousRows] = await Promise.all([
            activityRepo.rangeDays(userId, currentFrom, currentTo),
            activityRepo.rangeDays(userId, previousFrom, previousTo),
        ]);
    }

    const allRows = await activityRepo.allDays(userId);
    const streak = computeStreak(allRows, tzDayKey(now, tz));

    const current = aggregateRange(currentRows);
    const prev = aggregateRange(previousRows);
    // 'all' never loads a previous window, so there is nothing to compare to.
    const hasComparison = days !== null;
    const dueCount = await srsRepo.countDueCards(userId);

    const retCurrent =
        current.reviewed > 0 ? Math.round((current.correct / current.reviewed) * 100) : 0;
    const retPrev = prev.reviewed > 0 ? Math.round((prev.correct / prev.reviewed) * 100) : 0;

    return {
        range,
        reviewed: current.reviewed,
        correct: current.correct,
        retention: retCurrent,
        streak,
        dueCount,
        trends: {
            reviewed: {
                current: current.reviewed,
                previous: prev.reviewed,
                deltaPct: hasComparison ? pctChange(current.reviewed, prev.reviewed) : null,
            },
            retention: {
                current: retCurrent,
                previous: retPrev,
                deltaPct: hasComparison ? pctChange(retCurrent, retPrev) : null,
            },
        },
    };
};

// ---------- Series ----------

export type StatsSeriesPoint = { label: string; value: number };

// Pure: one point per local day on the `labels` scaffold (zeros included).
export const buildDailySeries = (
    rows: { date: Date; reviews: number }[],
    labels: string[],
): StatsSeriesPoint[] => {
    const byDay = new Map(rows.map((r) => [dateToDayKey(r.date), r.reviews]));
    return labels.map((label) => ({ label, value: byDay.get(label) ?? 0 }));
};

export const series = async (
    userId: string,
    range: StatsRange,
    tz: string = DEFAULT_TZ,
): Promise<{ range: StatsRange; points: StatsSeriesPoint[] }> => {
    const days = rangeDays(range) ?? ALL_RANGE_SERIES_DAYS;
    const labels = tzDayKeysEndingOn(new Date(), tz, days);
    const [from, to] = dayWindowBounds(labels);
    const rows = await activityRepo.rangeDays(userId, from, to);
    return { range, points: buildDailySeries(rows, labels) };
};

// ---------- Activity (year heatmap + current-month calendar) ----------

export type StatsActivity = {
    yearHeat: number[][]; // 53 weeks × 7 days, value = reviews
    monthCalendar: {
        month: string; // 'YYYY-MM'
        days: ({ date: string; reviews: number } | null)[]; // pad with nulls for leading blanks
    };
};

export const activity = async (userId: string, tz: string = DEFAULT_TZ): Promise<StatsActivity> => {
    // The viewer's local "today" as a day-counter Date (UTC midnight of that
    // calendar day) — all arithmetic below is on UTC getters of that value.
    const today = dayKeyToDate(tzDayKey(new Date(), tz));
    const yearStart = new Date(today);
    yearStart.setUTCDate(yearStart.getUTCDate() - 7 * 52); // ~53 weeks back

    const rows = await activityRepo.rangeDays(userId, yearStart, today);
    const byDate = new Map(rows.map((r) => [dateToDayKey(r.date), r.reviews]));

    // yearHeat: 53 columns (weeks, oldest → newest), 7 rows (Sun..Sat).
    const cols = 53;
    const yearHeat: number[][] = Array.from({ length: cols }, () =>
        new Array<number>(7).fill(0),
    );
    const cursor = new Date(yearStart);
    // Align cursor to start-of-week (Sunday).
    cursor.setUTCDate(cursor.getUTCDate() - cursor.getUTCDay());
    for (const week of yearHeat) {
        for (let r = 0; r < 7; r++) {
            const iso = dateToDayKey(cursor);
            week[r] = byDate.get(iso) ?? 0;
            cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
    }

    // Current calendar month, leading-blank-padded to start of week.
    const monthStart = new Date(today);
    monthStart.setUTCDate(1);
    const monthLabel = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;
    const monthDays: ({ date: string; reviews: number } | null)[] = [];
    for (let i = 0; i < monthStart.getUTCDay(); i++) {
        monthDays.push(null);
    }

    const monthCursor = new Date(monthStart);
    while (monthCursor.getUTCMonth() === monthStart.getUTCMonth()) {
        const iso = dateToDayKey(monthCursor);
        monthDays.push({ date: iso, reviews: byDate.get(iso) ?? 0 });
        monthCursor.setUTCDate(monthCursor.getUTCDate() + 1);
    }

    return { yearHeat, monthCalendar: { month: monthLabel, days: monthDays } };
};

// ---------- Per-deck performance ----------

export type StatsDeckRow = {
    deckId: string;
    title: string;
    cardCount: number;
    masteryPct: number;
    progressPct: number; // 0..100 — graded progress toward mastery (see deckProgressPct)
    retention: number; // 0..100 over all-time reviews of cards in this deck
    reviewed: number; // total review count over all-time
};

// Successful reviews a card needs to count as mastered (repetitions >= 3 —
// canonical in deck-stats.repository.ts / srs.service.ts MASTERY_THRESHOLD).
const MASTERY_STEPS = 3;

/**
 * Graded progress toward mastery: each card contributes min(repetitions, 3)/3.
 * `masteryPct` only moves once a card has 3 successful reviews in a row, which
 * SM-2 spaces over ~a week (1d, then 6d), so it sits at 0% after any number of
 * same-day sessions and users read it as broken. This moves with every
 * successful review (and drops back when "Forgot"/"Hard" resets a card).
 * `steps` = SUM(LEAST(repetitions, 3)) over the deck's cards.
 */
export const deckProgressPct = (steps: number, cardCount: number): number =>
    cardCount > 0 ? Math.min(100, Math.round((steps / (cardCount * MASTERY_STEPS)) * 100)) : 0;

export const decks = async (userId: string): Promise<StatsDeckRow[]> => {
    // Per-deck retention/review aggregates over all-time. Single query: card_progresses
    // joined to cards/decks for ownership; reviews are approximated by `repetitions`
    // and `correct ≈ repetitions` on a successful path. Until we add a per-rating
    // log table, this is a sound proxy that matches the FE's useDeckStats heuristic.
    const decksRows = await prisma.deck.findMany({
        where: { authorId: userId },
        orderBy: { updatedAt: 'desc' },
    });
    if (decksRows.length === 0) {
        return [];
    }

    const stats = await deckStatsRepo.aggregateDeckStats(
        userId,
        decksRows.map((d) => d.id),
    );
    const byId = new Map(stats.map((s) => [s.deckId, s]));

    // Per-deck reviews from card_progresses.repetitions (approx).
    const reviewRows = await prisma.$queryRaw<
        { deckId: string; reviews: bigint; correct: bigint; steps: bigint }[]
    >`
        SELECT c."deckId" AS "deckId",
               COALESCE(SUM(cp."repetitions"), 0)::bigint AS reviews,
               COALESCE(SUM(CASE WHEN cp."repetitions" > 0 THEN cp."repetitions" END), 0)::bigint AS correct,
               -- COALESCE first: LEAST ignores NULLs, so an unstudied card (no
               -- progress row) would otherwise count as fully mastered.
               COALESCE(SUM(LEAST(COALESCE(cp."repetitions", 0), ${MASTERY_STEPS})), 0)::bigint AS steps
          FROM cards c
          LEFT JOIN card_progresses cp ON cp."cardId" = c.id AND cp."userId" = ${userId}
         WHERE c."deckId" = ANY(${decksRows.map((d) => d.id)}::text[])
         GROUP BY c."deckId"
    `;
    const reviewsById = new Map(reviewRows.map((r) => [r.deckId, r]));

    return decksRows.map((d) => {
        const ds = buildStats(d.cardCount, byId.get(d.id));
        const rev = reviewsById.get(d.id);
        const reviews = Number(rev?.reviews ?? 0n);
        const correct = Number(rev?.correct ?? 0n);
        const retention = reviews > 0 ? Math.round((correct / reviews) * 100) : 0;
        return {
            deckId: d.id,
            title: d.title,
            cardCount: d.cardCount,
            masteryPct: ds.masteredPct,
            progressPct: deckProgressPct(Number(rev?.steps ?? 0n), d.cardCount),
            retention,
            reviewed: reviews,
        };
    });
};

// ---------- Study-time series (item 2) ----------
//
// Per-day total study time, summing *completed* session durations bucketed by
// the user's local calendar day. Same shape/range handling as getSeries (one
// point per day incl. zeros, oldest → today), with `value` in milliseconds.

export type StatsSeries = { range: StatsRange; unit: 'ms'; points: StatsSeriesPoint[] };

// Pure: sum durationMs into local-day buckets, keeping only days on the scaffold.
export const bucketDurationByTzDay = (
    rows: { durationMs: number; completedAt: Date }[],
    tz: string,
    labels: string[],
): StatsSeriesPoint[] => {
    const allowed = new Set(labels);
    const sums = new Map<string, number>();
    for (const r of rows) {
        const key = tzDayKey(r.completedAt, tz);
        if (!allowed.has(key)) {
            continue;
        }
        sums.set(key, (sums.get(key) ?? 0) + Math.max(0, r.durationMs));
    }
    return labels.map((label) => ({ label, value: sums.get(label) ?? 0 }));
};

export const studyTime = async (
    userId: string,
    range: StatsRange,
    tz: string,
): Promise<StatsSeries> => {
    const now = new Date();
    const days = rangeDays(range) ?? ALL_RANGE_SERIES_DAYS;
    const labels = tzDayKeysEndingOn(now, tz, days);
    const fromUtc = tzWindowLowerBoundUtc(now, tz, days);

    const rows = await sessionsRepo.findCompletedSessionsForStats(userId, fromUtc);
    return { range, unit: 'ms', points: bucketDurationByTzDay(rows, tz, labels) };
};

// ---------- Decks studied in range (item 4) ----------
//
// For the range, the decks that had a completed session: title, session count,
// cards reviewed (sum of cardsStudied), and last-studied time. Sorted by
// lastStudiedAt DESC. Same `{ items }` envelope as getDecks (plus `range`).

export type StatsDeckStudied = {
    deckId: string;
    title: string;
    sessionCount: number;
    cardsReviewed: number;
    lastStudiedAt: string; // ISO 8601 UTC
};

// Pure: group completed sessions by deck. `labelSet === null` means the 'all'
// range (no local-day filter — every completed session counts).
export const aggregateDecksStudied = (
    rows: { deckId: string; title: string; cardsStudied: number; completedAt: Date }[],
    tz: string,
    labelSet: Set<string> | null,
): StatsDeckStudied[] => {
    const byDeck = new Map<
        string,
        { title: string; sessionCount: number; cardsReviewed: number; lastMs: number }
    >();
    for (const r of rows) {
        if (labelSet && !labelSet.has(tzDayKey(r.completedAt, tz))) {
            continue;
        }
        const cur = byDeck.get(r.deckId) ?? {
            title: r.title,
            sessionCount: 0,
            cardsReviewed: 0,
            lastMs: 0,
        };
        cur.title = r.title;
        cur.sessionCount += 1;
        cur.cardsReviewed += Math.max(0, r.cardsStudied);
        cur.lastMs = Math.max(cur.lastMs, r.completedAt.getTime());
        byDeck.set(r.deckId, cur);
    }
    return [...byDeck.entries()]
        .map(([deckId, v]) => ({
            deckId,
            title: v.title,
            sessionCount: v.sessionCount,
            cardsReviewed: v.cardsReviewed,
            lastStudiedAt: new Date(v.lastMs).toISOString(),
        }))
        .sort((a, b) => b.lastStudiedAt.localeCompare(a.lastStudiedAt));
};

export const decksStudied = async (
    userId: string,
    range: StatsRange,
    tz: string,
): Promise<{ range: StatsRange; items: StatsDeckStudied[] }> => {
    const now = new Date();
    const days = rangeDays(range);

    let fromUtc: Date | null = null;
    let labelSet: Set<string> | null = null;
    if (days !== null) {
        labelSet = new Set(tzDayKeysEndingOn(now, tz, days));
        fromUtc = tzWindowLowerBoundUtc(now, tz, days);
    }

    const rows = await sessionsRepo.findCompletedSessionsForStats(userId, fromUtc);
    return { range, items: aggregateDecksStudied(rows, tz, labelSet) };
};

// ---------- Card-count series (item 3) — cumulative mastery curve ----------
//
// Cumulative count of cards ever mastered (repetitions >= 3) over time — a
// monotonic growth curve. Bucketed by the viewer's local day off the set-once
// CardProgress.masteredAt (see srsRepo.findMasteredAtTimestamps). Because
// masteredAt is never cleared on lapse, this can drift slightly above the
// current-mastered deck count — that's the intended "ever mastered" story.
export const CARD_SERIES_METRIC = 'cumulative_mastered' as const;

export type StatsCardSeries = {
    range: StatsRange;
    pending: boolean;
    metric: string | null;
    points: StatsSeriesPoint[];
};

// Pure: turn set-once mastery timestamps into a per-day cumulative series over
// `labels` (oldest → today, local-day keys). `point[0]` includes every card
// mastered on or before the first day in range (the baseline), so the curve
// never restarts at 0 when the user already had mastered cards. Monotonic
// non-decreasing by construction.
export const buildCumulativeMasteredSeries = (
    masteredAt: Date[],
    tz: string,
    labels: string[],
): StatsSeriesPoint[] => {
    const firstDay = labels[0];
    if (firstDay === undefined) {
        return [];
    }
    const inWindow = new Set(labels);

    let baseline = 0; // mastered strictly before the window's first day
    const perDay = new Map<string, number>();
    for (const at of masteredAt) {
        const key = tzDayKey(at, tz);
        if (key < firstDay) {
            baseline += 1; // ISO 'YYYY-MM-DD' compares lexicographically
        } else if (inWindow.has(key)) {
            perDay.set(key, (perDay.get(key) ?? 0) + 1);
        }
        // keys after the last label (future) can't occur: masteredAt <= now.
    }

    let running = baseline;
    return labels.map((label) => {
        running += perDay.get(label) ?? 0;
        return { label, value: running };
    });
};

export const cardSeries = async (
    userId: string,
    range: StatsRange,
    tz: string,
): Promise<StatsCardSeries> => {
    const now = new Date();
    const days = rangeDays(range) ?? ALL_RANGE_SERIES_DAYS;
    const labels = tzDayKeysEndingOn(now, tz, days);

    const timestamps = await srsRepo.findMasteredAtTimestamps(userId);
    return {
        range,
        pending: false,
        metric: CARD_SERIES_METRIC,
        points: buildCumulativeMasteredSeries(timestamps, tz, labels),
    };
};
