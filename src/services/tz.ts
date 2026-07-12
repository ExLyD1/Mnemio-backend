// Timezone-aware day bucketing for the session-based stats aggregations
// (study-time series, decks-studied). Pure — no DB, no side effects — so the
// timezone-boundary behaviour can be unit-tested directly.
//
// Existing /stats/series + /stats/activity bucket by UTC calendar day (they read
// the DailyActivity rollup, which is written at UTC midnight). The newer session
// aggregations bucket by the *user's* local calendar day instead, because a
// session finished at 23:30 local should land on that local day, not roll into
// the next UTC day.

// 'YYYY-MM-DD' for an instant, as seen on the wall clock in `tz`.
// en-CA formats dates as YYYY-MM-DD; the explicit options keep it stable across
// Node ICU versions.
export const tzDayKey = (at: Date, tz: string): string =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(at);

// The `days` consecutive local day keys ending on `end`'s local day, oldest
// first — the x-axis scaffold for a per-day series (mirrors how getSeries walks
// one point per day). Calendar arithmetic runs on a UTC anchor purely as a
// day counter (Date.UTC has no DST), so it never skips or repeats a label.
export const tzDayKeysEndingOn = (end: Date, tz: string, days: number): string[] => {
    const [y, m, d] = tzDayKey(end, tz).split('-').map(Number);
    const anchor = Date.UTC(y!, m! - 1, d!);
    const keys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
        const dt = new Date(anchor - i * 86_400_000);
        keys.push(
            `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
                dt.getUTCDate(),
            ).padStart(2, '0')}`,
        );
    }
    return keys;
};

// A UTC instant guaranteed to be at or before the true start of the window's
// first local day, used only to narrow the DB scan. It is intentionally loose
// (one extra day of slack) because membership in the window is decided
// authoritatively by comparing local day keys — never by this bound. That keeps
// us correct regardless of the tz's UTC offset or a DST shift at the edge.
export const tzWindowLowerBoundUtc = (end: Date, tz: string, days: number): Date => {
    const keys = tzDayKeysEndingOn(end, tz, days);
    const [y, m, d] = keys[0]!.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!) - 86_400_000);
};
