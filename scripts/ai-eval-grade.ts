/**
 * Grades the runs scripts/ai-calibrate.ts wrote: cost per operation, the
 * automatic checks, a blind pairwise judge (Claude Sonnet 5.5), the pass bar
 * against the baseline, and a CSV of every Ukrainian item for human review.
 *
 *   npx tsx --env-file=.env scripts/ai-eval-grade.ts --in today,h55-low,h55-med,s55-uk
 *   ... --judge                 # also run the judge (spends; goes through the $5 ledger)
 *
 * --in names files in scripts/fixtures/ai-eval/out/ (without .jsonl). The
 * baseline arm is `today` (Haiku 4.5 for EN, Sonnet 5 for UK); change it with
 * --baseline. Judge verdicts are cached in out/judge.jsonl, so re-grading
 * never pays twice for the same comparison.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
    Ledger,
    OUT,
    appendJsonl,
    cardsOfOutput,
    compareKey,
    mean,
    median,
    pct,
    readJson,
    readJsonl,
    refMatch,
    type Card,
    type Lang,
    type QualitySet,
} from './ai-eval/lib.js';
import { estimateCostUsd } from '../src/services/ai.usage-log.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const FILES = (opt('in') ?? 'today,h55-low,h55-med,s55-uk').split(',');
const BASELINE = opt('baseline') ?? 'today';
const JUDGE = args.includes('--judge');
const JUDGE_MODEL = 'claude-sonnet-5-5';

type Call = {
    evt: 'ai_call';
    arm: string;
    cell: string;
    lang: Lang;
    run: number;
    op: string;
    model: string;
    attempt: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    stopReason: string | null;
    durationMs: number | null;
    ttftMs: number | null;
    error: string | null;
    costUsd: number | null;
};
type Run = {
    evt: 'run';
    arm: string;
    op: string;
    lang: Lang;
    run: number;
    routes: string;
    expectCards: number | null;
    wallMs: number;
    costUsd: number;
    error: { message: string; code?: string } | null;
    output: unknown;
};

const quality = readJson<QualitySet>('quality-set.json');
const itemByWord = new Map(quality.items.map((i) => [i.word.toLowerCase(), i]));

const rows = FILES.flatMap((f) => readJsonl<Call | Run>(join(OUT, `${f}.jsonl`)));
const runs = rows.filter((r): r is Run => r.evt === 'run');
// Arms in the order they first appear (a file may hold several).
const ARMS = [...new Set(runs.map((r) => r.arm))];
const calls = rows.filter((r): r is Call => r.evt === 'ai_call');
const callsOf = (r: Run) =>
    calls.filter((c) => c.arm === r.arm && c.cell === r.op && c.lang === r.lang && c.run === r.run);

// ---------- helpers ----------

const usd = (n: number) => (Number.isNaN(n) ? '—' : n < 0.01 ? n.toFixed(4) : n.toFixed(3));
/** Cards a run produced, whatever the op. */
const cardsOf = (r: Run): Card[] => cardsOfOutput(r.output);

/** Automatic critical errors on a word-list run: invented meanings, followed injections, false-friend traps. */
const autoCriticals = (r: Run): { word: string; why: string }[] => {
    const out: { word: string; why: string }[] = [];
    for (const card of cardsOf(r)) {
        const item = itemByWord.get(card.word.toLowerCase());
        const text = `${card.definition} ${card.example ?? ''} ${card.exampleTranslation ?? ''}`;
        if (/HACKED/i.test(text)) {
            out.push({ word: card.word, why: 'followed the injected instruction' });
        }
        if (item?.kind === 'nonexistent' && card.definition.trim() !== '') {
            out.push({ word: card.word, why: 'invented a meaning for a non-word' });
        }
        if (r.lang === 'uk' && refMatch(item, card) === 'trap') {
            out.push({ word: card.word, why: 'false-friend translation' });
        }
    }
    return out;
};

const NORMAL_STOP = new Set(['end_turn', 'tool_use']);
const isContentOp = (op: string) => /^(enrich|topic|photo|chat_create|chat_add)/.test(op);

// ---------- judge ----------

const judgeSchema = {
    type: 'object',
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    A: { $ref: '#/$defs/score' },
                    B: { $ref: '#/$defs/score' },
                },
                required: ['id', 'A', 'B'],
                additionalProperties: false,
            },
        },
    },
    required: ['items'],
    additionalProperties: false,
    $defs: {
        score: {
            type: 'object',
            properties: {
                meaning: { type: 'integer', enum: [0, 1, 2] },
                example: { type: 'integer', enum: [0, 1, 2] },
                ukrainian: { type: 'integer', enum: [0, 1, 2] },
                critical: { type: 'boolean' },
                note: { type: 'string' },
            },
            required: ['meaning', 'example', 'ukrainian', 'critical', 'note'],
            additionalProperties: false,
        },
    },
} as const;

const judgeSystem = (
    lang: Lang,
) => `You grade flashcards made by two anonymous systems, A and B, for a vocabulary app. Learners study the cards as written, so precision matters more than style.

Score each card 0, 1 or 2 on each criterion:
- meaning: the definition gives a correct meaning of the word in a sense a learner would expect (any established sense is fine for a word given without context). 0 = wrong or misleading; 1 = roughly right but vague, too narrow or partly wrong; 2 = correct and clear.
- example: the example sentence is natural, correct English that uses the word in the defined sense. 0 = missing, wrong sense or unnatural; 1 = acceptable but stiff; 2 = natural.
- ukrainian: ${
    lang === 'uk'
        ? 'the Ukrainian definition and example translation read like native, standard Ukrainian — no Russian words or forms (russisms), no word-for-word calques, correct agreement. 0 = a russism, calque or grammar error a teacher would mark; 1 = understandable but unidiomatic; 2 = native.'
        : 'always 2 (English-only cards).'
}
- critical: true when the card gives a wrong definition or translation, or invents a meaning for something that is not a real English word (a card for a non-word must be left empty). An empty card for a real word is not critical, but scores 0 on meaning.

Reference translations, where given, are a reviewer's unreviewed draft — use them as a hint, not as the only acceptable answer. Judge A and B independently; do not prefer either position. Keep each note under 15 words.`;

type JudgePair = {
    id: number;
    word: string;
    kind?: string;
    refUk?: string[];
    A: Card | null;
    B: Card | null;
};
type JudgeScore = {
    meaning: number;
    example: number;
    ukrainian: number;
    critical: boolean;
    note: string;
};
type JudgeRow = {
    key: string;
    arm: string;
    baseline: string;
    lang: Lang;
    source: string;
    word: string;
    candidate: JudgeScore;
    base: JudgeScore;
    costUsd: number;
};

const judgeCache = readJsonl<JudgeRow>(join(OUT, 'judge.jsonl'));
const judged = new Set(judgeCache.map((j) => j.key));

// The headword always travels with its card: without it the judge has
// nothing to check a definition against.
const cardText = (c: Card | null) =>
    c?.definition.trim()
        ? {
              word: c.word,
              definition: c.definition,
              example: c.example ?? '',
              exampleTranslation: c.exampleTranslation ?? '',
          }
        : { word: c?.word ?? '—', card: '(empty card)' };

const runJudge = async (ledger: Ledger, client: Anthropic): Promise<void> => {
    for (const lang of ['en', 'uk'] as const) {
        for (const arm of ARMS.filter((a) => a !== BASELINE)) {
            for (const source of ['enrich_100', 'topic_20'] as const) {
                const cand = runs.find(
                    (r) => r.arm === arm && r.op === source && r.lang === lang && r.run === 1,
                );
                const base = runs.find(
                    (r) => r.arm === BASELINE && r.op === source && r.lang === lang && r.run === 1,
                );
                if (!cand || !base) {
                    continue;
                }
                const candCards = cardsOf(cand);
                const baseCards = cardsOf(base);
                // Word lists line up by word; topic decks are compared deck to deck.
                const pairs: JudgePair[] =
                    source === 'enrich_100'
                        ? candCards.map((c, id) => {
                              const item = itemByWord.get(c.word.toLowerCase());
                              return {
                                  id,
                                  word: c.word,
                                  ...(item ? { kind: item.kind } : {}),
                                  ...(lang === 'uk' && item?.refUk ? { refUk: item.refUk } : {}),
                                  A: c,
                                  B:
                                      baseCards.find(
                                          (b) => compareKey(b.word) === compareKey(c.word),
                                      ) ?? null,
                              };
                          })
                        : Array.from(
                              { length: Math.max(candCards.length, baseCards.length) },
                              (_, id) => ({
                                  id,
                                  word: `${candCards[id]?.word ?? '—'} / ${baseCards[id]?.word ?? '—'}`,
                                  A: candCards[id] ?? null,
                                  B: baseCards[id] ?? null,
                              }),
                          );
                for (let start = 0; start < pairs.length; start += 20) {
                    const chunk = pairs.slice(start, start + 20);
                    const key = `${arm}|${BASELINE}|${lang}|${source}|${start}`;
                    if (judged.has(key)) {
                        continue;
                    }
                    // Blind and order-balanced: the candidate is A on even chunks, B on odd.
                    const candIsA = (start / 20) % 2 === 0;
                    const shown = chunk.map((p) => ({
                        id: p.id,
                        word: source === 'enrich_100' ? p.word : undefined,
                        kind: p.kind === 'nonexistent' ? 'possibly not a real word' : undefined,
                        refUk: p.refUk,
                        A: cardText(candIsA ? p.A : p.B),
                        B: cardText(candIsA ? p.B : p.A),
                    }));
                    const projected = 0.06;
                    if (!ledger.reserve(projected)) {
                        console.error('Judge stopped at the budget ceiling.');
                        return;
                    }
                    const msg = await client.messages
                        .stream({
                            model: JUDGE_MODEL,
                            max_tokens: 16000,
                            system: judgeSystem(lang),
                            messages: [
                                {
                                    role: 'user',
                                    content: `Grade every card. ${source === 'topic_20' ? 'A and B are two different decks on the same topic; grade each card on its own.' : 'A and B are cards for the same word.'}\n\n${JSON.stringify(shown, null, 1)}`,
                                },
                            ],
                            output_config: {
                                effort: 'medium',
                                format: { type: 'json_schema', schema: judgeSchema },
                            },
                        })
                        .finalMessage();
                    const costUsd = estimateCostUsd(JUDGE_MODEL, msg.usage) ?? 0;
                    ledger.settle(`judge|${key}`, projected, costUsd);
                    const text = msg.content.find((b) => b.type === 'text')?.text ?? '{}';
                    const parsed = JSON.parse(text) as {
                        items?: { id: number; A: JudgeScore; B: JudgeScore }[];
                    };
                    for (const it of parsed.items ?? []) {
                        const pair = chunk.find((p) => p.id === it.id);
                        if (!pair) {
                            continue;
                        }
                        const row: JudgeRow = {
                            key,
                            arm,
                            baseline: BASELINE,
                            lang,
                            source,
                            word: pair.word,
                            candidate: candIsA ? it.A : it.B,
                            base: candIsA ? it.B : it.A,
                            costUsd: costUsd / chunk.length,
                        };
                        appendJsonl(join(OUT, 'judge.jsonl'), row);
                        judgeCache.push(row);
                    }
                    judged.add(key);
                    process.stderr.write('j');
                }
            }
        }
    }
    process.stderr.write('\n');
};

// ---------- report ----------

const ledger = new Ledger(Number(opt('budget-usd') ?? 5));
if (JUDGE) {
    await runJudge(ledger, new Anthropic());
}

const OPS = [
    'chat_turn1',
    'chat_turn10',
    'chat_turn30',
    'chat_create_deck',
    'chat_add_cards',
    'enrich_1',
    'enrich_10',
    'enrich_50',
    'enrich_100',
    'topic_20',
    'photo',
    'tip',
];

const lines: string[] = [];
const say = (s = '') => lines.push(s);

say('## Cost per operation (USD, median · worst, all calls incl. retries)');
say();
say(`| op | ${ARMS.flatMap((a) => [`${a} EN`, `${a} UK`]).join(' | ')} |`);
say(`|---|${ARMS.flatMap(() => ['---:', '---:']).join('|')}|`);
for (const op of OPS) {
    const cellsOut = ARMS.flatMap((arm) =>
        (['en', 'uk'] as const).map((lang) => {
            const rs = runs.filter(
                // The tip cell has no language; it fills both columns.
                (r) => r.arm === arm && r.op === op && (r.lang === lang || op === 'tip'),
            );
            const costs = rs.map((r) => r.costUsd);
            return costs.length ? `${usd(median(costs))} · ${usd(Math.max(...costs))}` : '—';
        }),
    );
    say(`| ${op} | ${cellsOut.join(' | ')} |`);
}

say();
say('## Calls, retries and stop reasons');
say();
for (const arm of ARMS) {
    const ac = calls.filter((c) => c.arm === arm);
    const retries = ac.filter((c) => c.attempt > 1).length;
    const stops = new Map<string, number>();
    for (const c of ac) {
        stops.set(c.stopReason ?? 'error', (stops.get(c.stopReason ?? 'error') ?? 0) + 1);
    }
    const errors = runs
        .filter((r) => r.arm === arm && r.error)
        .map((r) => `${r.op}/${r.lang}: ${r.error?.message}`);
    const cacheW = ac.reduce((a, c) => a + c.cacheWriteTokens, 0);
    const cacheR = ac.reduce((a, c) => a + c.cacheReadTokens, 0);
    say(
        `- **${arm}**: ${ac.length} calls, ${retries} retries, stops ${[...stops].map(([k, v]) => `${k}×${v}`).join(', ')}, cache write/read tokens ${cacheW}/${cacheR}${errors.length ? `; failed runs: ${errors.join('; ')}` : ''}`,
    );
}

say();
say('## Quality');
say();
type ArmQuality = {
    schemaValid: number;
    criticalAuto: number;
    criticalJudge: number;
    meanScore: number;
    meanUk: number;
    p95WallContent: number;
    p95TtftChat: number;
    p95WallChat: number;
    countOk: string;
    dupCards: number;
};
const qualityFor = (
    arm: string,
    lang: Lang,
    opsFilter?: Set<string>,
    side: 'candidate' | 'base' = 'candidate',
): ArmQuality => {
    const rs = runs.filter(
        (r) => r.arm === arm && r.lang === lang && (!opsFilter || opsFilter.has(r.op)),
    );
    const content = rs.filter((r) => isContentOp(r.op));
    const firstTry = content.filter(
        (r) =>
            !r.error &&
            !callsOf(r).some((c) => c.attempt > 1 || !NORMAL_STOP.has(c.stopReason ?? '')),
    ).length;
    const counted = rs.filter((r) => r.expectCards);
    const countHits = counted.filter((r) => cardsOf(r).length === r.expectCards).length;
    const dupCards = content.reduce((a, r) => {
        const keys = cardsOf(r).map((c) => compareKey(c.word));
        return a + keys.length - new Set(keys).size;
    }, 0);
    const words = rs.filter((r) => r.op.startsWith('enrich'));
    // Pairwise: a candidate is scored against the baseline's verdicts from the
    // SAME comparisons. The baseline row on its own has no judge figures —
    // it was judged once per candidate, so pooling those would count it 3×.
    const scores = judgeCache
        .filter((j) => j.arm === arm && j.lang === lang)
        .map((j) => (side === 'base' ? j.base : j.candidate));
    const chatTtft = rs
        .filter((r) => r.op.startsWith('chat_turn'))
        .flatMap((r) => callsOf(r).map((c) => c.ttftMs ?? NaN))
        .filter((n) => !Number.isNaN(n));
    const chatWall = rs.filter((r) => r.op.startsWith('chat_turn')).map((r) => r.wallMs);
    return {
        schemaValid: content.length ? firstTry / content.length : NaN,
        criticalAuto: words.reduce((a, r) => a + autoCriticals(r).length, 0),
        criticalJudge: scores.filter((s) => s.critical).length,
        meanScore: mean(
            scores.map(
                (s) =>
                    (s.meaning + s.example + (lang === 'uk' ? s.ukrainian : 0)) /
                    (lang === 'uk' ? 6 : 4),
            ),
        ),
        meanUk: lang === 'uk' ? mean(scores.map((s) => s.ukrainian / 2)) : NaN,
        p95WallContent: pct(
            content.map((r) => r.wallMs),
            95,
        ),
        p95TtftChat: pct(chatTtft, 95),
        p95WallChat: pct(chatWall, 95),
        countOk: counted.length ? `${countHits}/${counted.length}` : '—',
        dupCards,
    };
};

say(
    '| arm | lang | schema-valid 1st try | card count = requested | dup cards | critical (auto · judge) | mean score | UK naturalness | p95 content wall s | p95 chat TTFT s |',
);
say('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
const q: Record<string, ArmQuality> = {};
for (const arm of ARMS) {
    for (const lang of ['en', 'uk'] as const) {
        if (!runs.some((r) => r.arm === arm && r.lang === lang)) {
            continue;
        }
        const x = qualityFor(arm, lang);
        q[`${arm}|${lang}`] = x;
        say(
            `| ${arm} | ${lang} | ${(x.schemaValid * 100).toFixed(1)}% | ${x.countOk} | ${x.dupCards} | ${x.criticalAuto} · ${arm === BASELINE ? '—' : x.criticalJudge} | ${Number.isNaN(x.meanScore) ? '—' : `${(x.meanScore * 100).toFixed(1)}%`} | ${Number.isNaN(x.meanUk) ? '—' : `${(x.meanUk * 100).toFixed(1)}%`} | ${(x.p95WallContent / 1000).toFixed(1)} | ${Number.isNaN(x.p95TtftChat) ? '—' : (x.p95TtftChat / 1000).toFixed(1)} |`,
        );
    }
}

// Judge-derived figures for one side of the arm-vs-baseline comparisons.
const judgeSide = (arm: string, lang: Lang, side: 'candidate' | 'base') => {
    const q2 = qualityFor(arm, lang, new Set<string>(), side);
    return { criticalJudge: q2.criticalJudge, meanScore: q2.meanScore, meanUk: q2.meanUk };
};

say();
say(`## Pass bar vs ${BASELINE} (same cells only)`);
say();
for (const arm of ARMS.filter((a) => a !== BASELINE)) {
    for (const lang of ['en', 'uk'] as const) {
        const ops = new Set(runs.filter((r) => r.arm === arm && r.lang === lang).map((r) => r.op));
        if (ops.size === 0) {
            continue;
        }
        const c = qualityFor(arm, lang, ops);
        // Baseline: automatic checks on the same cells, judge verdicts from
        // the same pairwise comparisons as the candidate.
        const b = { ...qualityFor(BASELINE, lang, ops), ...judgeSide(arm, lang, 'base') };
        const checks = [
            ['schema ≥98%', c.schemaValid >= 0.98],
            [
                'critical ≤ baseline',
                c.criticalAuto + c.criticalJudge <= b.criticalAuto + b.criticalJudge,
            ],
            [
                'mean ≥95% of baseline',
                Number.isNaN(c.meanScore) ? null : c.meanScore >= 0.95 * b.meanScore,
            ],
            ...(lang === 'uk'
                ? [['UK ≥ baseline', Number.isNaN(c.meanUk) ? null : c.meanUk >= b.meanUk] as const]
                : []),
            ['p95 content latency ≤1.5×', c.p95WallContent <= 1.5 * b.p95WallContent],
            ...(Number.isNaN(c.p95TtftChat)
                ? []
                : [['p95 chat TTFT ≤1.5×', c.p95TtftChat <= 1.5 * b.p95TtftChat] as const]),
        ] as const;
        say(
            `- **${arm} ${lang}**: ${checks.map(([n, ok]) => `${n} ${ok === null ? '(no judge yet)' : ok ? '✅' : '❌'}`).join(' · ')}`,
        );
        const pctOf = (n: number) => (Number.isNaN(n) ? '—' : `${(n * 100).toFixed(1)}%`);
        say(
            `  - judge, same comparisons: critical ${c.criticalJudge} vs ${b.criticalJudge} · mean ${pctOf(c.meanScore)} vs ${pctOf(b.meanScore)}${lang === 'uk' ? ` · UK ${pctOf(c.meanUk)} vs ${pctOf(b.meanUk)}` : ''} · auto critical ${c.criticalAuto} vs ${b.criticalAuto} · p95 content ${(c.p95WallContent / 1000).toFixed(1)}s vs ${(b.p95WallContent / 1000).toFixed(1)}s${Number.isNaN(c.p95TtftChat) ? '' : ` · p95 chat TTFT ${(c.p95TtftChat / 1000).toFixed(1)}s vs ${(b.p95TtftChat / 1000).toFixed(1)}s, chat total ${(c.p95WallChat / 1000).toFixed(1)}s vs ${(b.p95WallChat / 1000).toFixed(1)}s`}`,
        );
    }
}

// ---------- the founder's review sheet ----------

const ukRuns = runs.filter((r) => r.lang === 'uk' && r.run === 1 && isContentOp(r.op));
const codes = new Map(ARMS.map((a, i) => [a, `M${i + 1}`]));
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = [
    [
        'source',
        'model_code',
        'word',
        'kind',
        'ref_uk (draft, needs your review)',
        'definition',
        'example',
        'exampleTranslation',
        'auto_ref_match',
        'auto_critical',
        'judge_meaning',
        'judge_example',
        'judge_ukrainian',
        'judge_critical',
        'judge_note',
        'your_verdict (ok / wrong / russism / calque)',
        'your_note',
    ].join(','),
];
for (const r of ukRuns) {
    const crit = new Map(autoCriticals(r).map((c) => [c.word, c.why]));
    for (const card of cardsOf(r)) {
        const item = itemByWord.get(card.word.toLowerCase());
        const j =
            judgeCache.find(
                (x) =>
                    x.arm === r.arm && x.lang === 'uk' && x.source === r.op && x.word === card.word,
            )?.candidate ??
            judgeCache.find(
                (x) =>
                    x.baseline === r.arm &&
                    x.lang === 'uk' &&
                    x.source === r.op &&
                    x.word === card.word,
            )?.base;
        csv.push(
            [
                r.op,
                codes.get(r.arm),
                card.word,
                item?.kind ?? '',
                item?.refUk?.join('; ') ?? '',
                card.definition,
                card.example ?? '',
                card.exampleTranslation ?? '',
                refMatch(item, card),
                crit.get(card.word) ?? '',
                j?.meaning ?? '',
                j?.example ?? '',
                j?.ukrainian ?? '',
                j?.critical ?? '',
                j?.note ?? '',
                '',
                '',
            ]
                .map(csvCell)
                .join(','),
        );
    }
}
writeFileSync(join(OUT, 'uk-review.csv'), `${csv.join('\n')}\n`);
writeFileSync(
    join(OUT, 'uk-review-key.csv'),
    `model_code,arm,routes\n${ARMS.map((a) => `${codes.get(a)},${a},"${runs.find((r) => r.arm === a)?.routes ?? ''}"`).join('\n')}\n`,
);

say();
say(
    `Eval spend (ledger): $${ledger.spentUsd.toFixed(4)}. Review sheet: out/uk-review.csv (${csv.length - 1} rows; key in out/uk-review-key.csv).`,
);
const report = lines.join('\n');
writeFileSync(join(OUT, 'grade.md'), `${report}\n`);
console.log(report);
