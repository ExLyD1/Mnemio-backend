/**
 * Spec 002 cleanup: classify decks the subject migration couldn't place, and
 * repair decks whose language is outside the supported list.
 *
 *   npx tsx scripts/backfill-subjects.ts --dry-run          # report only, WRITES NOTHING
 *   npx tsx scripts/backfill-subjects.ts --apply            # write the changes
 *   npx tsx scripts/backfill-subjects.ts --dry-run --limit 20
 *
 * Without --apply it is always a dry run: it makes the (cheap) AI calls and
 * prints every proposed change, but never writes. Run it first, read the
 * output, then run it again with --apply. Re-running is safe — it only touches
 * decks that are still unresolved.
 *
 * Needs DATABASE_URL, and ANTHROPIC_API_KEY + AI_PROVIDER=anthropic for real
 * classification (the mock provider falls back to keyword rules). It prints
 * the database host first so you can confirm which environment it will touch.
 * The calls are a system cost: they are not charged to any user's AI budget.
 */
import 'dotenv/config';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { runBackfill } from '../src/services/subjects-backfill.service.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const explicitDry = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit'));
const limit = limitArg
    ? Number(limitArg.includes('=') ? limitArg.split('=')[1] : args[args.indexOf(limitArg) + 1])
    : undefined;

const main = async (): Promise<void> => {
    if (apply && explicitDry) {
        throw new Error('Pass either --dry-run or --apply, not both.');
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error('--limit needs a positive integer.');
    }
    const dryRun = !apply;

    let host = 'unknown';
    try {
        const u = new URL(env.DATABASE_URL);
        host = `${u.hostname}:${u.port || '5432'}${u.pathname}`;
    } catch {
        // leave "unknown"
    }

    console.log(
        `backfill-subjects · ${dryRun ? 'DRY RUN (no writes)' : 'APPLY (writing)'} · db ${host} · ai ${env.AI_PROVIDER}${limit ? ` · limit ${limit}` : ''}\n`,
    );

    const report = await runBackfill({
        dryRun,
        limit,

        log: (line) => console.log(line),
    });

    const { subjects, languages } = report;

    console.log(
        `\n${dryRun ? 'Would change' : 'Changed'}:\n` +
            `  subjects  considered ${subjects.considered} · ai ${subjects.ai} · rules ${subjects.rules}` +
            `${dryRun ? '' : ` · written ${subjects.written}`}\n` +
            `  languages considered ${languages.considered} · resolved ${languages.resolved}` +
            `${dryRun ? '' : ` · written ${languages.written}`} · unresolved ${languages.unresolved.length}\n${
                dryRun ? '\nNothing was written. Re-run with --apply to write these changes.\n' : ''
            }`,
    );
};

main()
    .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
