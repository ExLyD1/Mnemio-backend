/**
 * Pre-launch AI cost calibration.
 *
 * Runs each AI operation through the REAL provider code (real prompts, tools,
 * models, retries) a few times and reports measured tokens and cost per
 * operation — the numbers the cost model otherwise has to guess from prompt
 * sizes. Nothing is written to the database; chat tool calls are stubbed, so
 * the generation call a chat deck makes is measured by its own scenarios.
 *
 *   npx tsx --env-file=.env scripts/ai-calibrate.ts            # dry run: lists scenarios
 *   npx tsx --env-file=.env scripts/ai-calibrate.ts --run      # spends ~$0.3-1 on the API key in .env
 *   ... --runs 3 --image ./page.jpg --out calibration.json
 *
 * Use a dev/test API key, not production's.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};

// Must be set before env.ts is imported (ESM hoists static imports).
process.env['AI_PROVIDER'] = 'anthropic';

const { anthropicProvider } = await import('../src/services/ai.provider.anthropic.js');
const { buildChatSystemPrompt } = await import('../src/services/chat.prompt.js');
const { CREATE_DECK_TOOL_DEF } = await import('../src/services/chat.tools.js');
const { setAiCallListener } = await import('../src/services/ai.usage-log.js');
const { env } = await import('../src/config/env.js');
import type { AiCallRecord } from '../src/services/ai.usage-log.js';
import type { AiImageInput, ChatToolDef, ChatTurn } from '../src/services/ai.provider.js';

const RUNS = Number(opt('runs') ?? 2);
const WORDS_DE = [
    'der Apfel',
    'die Birne',
    'das Brot',
    'die Milch',
    'der Käse',
    'das Wasser',
    'der Kaffee',
    'die Suppe',
    'der Reis',
    'die Nudel',
    'das Fleisch',
    'der Fisch',
    'das Ei',
    'der Zucker',
    'das Salz',
    'die Butter',
    'der Kuchen',
    'die Tomate',
    'die Zwiebel',
    'die Kartoffel',
];
const BUDGET = {
    decksRemaining: 2,
    decksCap: 2,
    actionsRemaining: 5,
    actionsCap: 5,
    resetsAt: '2026-10-11T00:00:00.000Z',
    plan: 'free' as const,
};

const FILLER_EN =
    'Great question! "Affect" is usually a verb meaning to influence something, while "effect" is usually a noun meaning the result of a change. For example: *The weather affected our plans.* and *The weather had a big effect on our plans.* A quick memory trick is RAVEN: Remember, Affect is a Verb, Effect is a Noun. There are rare exceptions, such as "effect" as a verb meaning to bring about ("to effect change"). Would you like a few more practice sentences, or should I turn these into flashcards for you?';
const FILLER_UK =
    'Гарне запитання! «Affect» зазвичай є дієсловом і означає впливати на щось, а «effect» зазвичай є іменником і означає результат змін. Наприклад: *Погода вплинула на наші плани.* та *Погода сильно вплинула на наші плани.* Простий спосіб запам’ятати — правило RAVEN: Affect — це Verb, Effect — це Noun. Є рідкісні винятки, наприклад «effect» як дієслово у значенні «здійснити» («to effect change»). Хочете ще кілька речень для практики чи зробити з них картки?';

const history = (n: number, uk: boolean): ChatTurn[] =>
    Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content:
            i % 2 === 0
                ? uk
                    ? 'Поясни, будь ласка, ще одне слово з прикладами.'
                    : 'Please explain another word with examples.'
                : uk
                  ? FILLER_UK
                  : FILLER_EN,
    }));

type Scenario = { label: string; run: () => Promise<unknown> };
const scenarios: Scenario[] = [];
const add = (label: string, run: () => Promise<unknown>) => scenarios.push({ label, run });

const stubTools = (okWords: string[]) => ({
    defs: [CREATE_DECK_TOOL_DEF as unknown as ChatToolDef],
    run: async () => ({
        ok: true as const,
        data: { type: 'deck', title: 'Food', cardCount: okWords.length },
        resultJson: JSON.stringify({
            ok: true,
            title: 'Food',
            cardCount: okWords.length,
            action: 'created',
            sourceLanguage: 'en',
            targetLanguage: 'de',
            words: okWords,
        }),
    }),
});

for (const uk of [false, true]) {
    const loc = uk ? 'uk' : 'en';
    const sys = buildChatSystemPrompt(
        undefined,
        loc,
        false,
        { native: loc, learning: ['de'] },
        BUDGET,
    );
    const q = uk
        ? 'Поясни різницю між "affect" та "effect" з двома прикладами.'
        : 'Explain the difference between "affect" and "effect" with two examples.';
    const chat = (messages: ChatTurn[], tools = stubTools([])) =>
        anthropicProvider.chat({
            messages,
            systemPrompt: sys,
            maxOutputTokens: env.AI_CHAT_MAX_OUTPUT_TOKENS,
            tools,
        });
    add(`chat first message [${loc}]`, () => chat([{ role: 'user', content: q }]));
    add(`chat late message, 19 prior turns [${loc}]`, () =>
        chat([...history(19, uk), { role: 'user', content: q }]),
    );
    add(`chat deck request, 10 words (tool round 1+2, generation stubbed) [${loc}]`, () =>
        chat(
            [
                {
                    role: 'user',
                    content: uk
                        ? 'Зроби колоду з 10 німецьких слів про їжу.'
                        : 'Make me a deck of 10 German words about food.',
                },
            ],
            stubTools(WORDS_DE.slice(0, 10)),
        ),
    );
    const src = uk ? 'uk' : 'en';
    for (const n of [20, 1]) {
        add(`word-list fill, ${n} word${n > 1 ? 's' : ''} [defs ${src}]`, () =>
            anthropicProvider.enrichWords({
                words: WORDS_DE.slice(0, n),
                sourceLanguage: src,
                targetLanguage: 'de',
            }),
        );
    }
    for (const count of [8, 20]) {
        add(`deck from topic, ${count} cards [defs ${src}]`, () =>
            anthropicProvider.generateDeck({
                topic: 'Food and cooking',
                sourceLanguage: src,
                targetLanguage: 'de',
                count,
            }),
        );
    }
}
add('tip (suggest)', () =>
    anthropicProvider.suggest({ context: 'dashboard', dueCount: 12, streak: 3 }),
);

const imagePath = opt('image');
if (imagePath) {
    const ext = extname(imagePath).toLowerCase();
    const mediaType =
        (
            { '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<
                string,
                AiImageInput['mediaType']
            >
        )[ext] ?? 'image/jpeg';
    const image: AiImageInput = {
        mediaType,
        dataBase64: readFileSync(imagePath).toString('base64'),
    };
    for (const src of ['en', 'uk']) {
        add(`photo -> deck, 8 cards [defs ${src}]`, () =>
            anthropicProvider.deckFromImage({
                sourceLanguage: src,
                targetLanguage: 'de',
                count: 8,
                image,
            }),
        );
    }
}

if (!flag('run')) {
    console.log(
        `Dry run. ${scenarios.length} scenarios x ${RUNS} runs. Models: chat/tips ${env.ANTHROPIC_MODEL}, Ukrainian content ${env.ANTHROPIC_CONTENT_MODEL_UK}.`,
    );
    scenarios.forEach((s) => console.log(' -', s.label));
    console.log('Add --run to spend API credits. Add --image <file> to include photo scenarios.');
    process.exit(0);
}
if (!env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exit(1);
}

type Row = { label: string; run: number; calls: AiCallRecord[]; error?: string };
const rows: Row[] = [];
let current: Row | null = null;
setAiCallListener((r) => current?.calls.push(r));

for (const s of scenarios) {
    for (let run = 1; run <= RUNS; run++) {
        current = { label: s.label, run, calls: [] };
        try {
            await s.run();
        } catch (e) {
            current.error = (e as Error).message;
        }
        rows.push(current);
        process.stderr.write('.');
    }
}
process.stderr.write('\n');

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const usd = (n: number) => `$${n.toFixed(4)}`;

console.log(
    '| Operation | calls/run | input tok | output tok | cache w/r tok | cost/run (USD) | flags |',
);
console.log('|---|---:|---:|---:|---:|---:|---|');
for (const label of [...new Set(rows.map((r) => r.label))]) {
    const rs = rows.filter((r) => r.label === label && !r.error);
    const errs = rows.filter((r) => r.label === label && r.error).length;
    if (rs.length === 0) {
        console.log(
            `| ${label} | - | - | - | - | - | ALL FAILED: ${rows.find((r) => r.label === label)?.error} |`,
        );
        continue;
    }
    const flags: string[] = [];
    if (rs.some((r) => r.calls.some((c) => c.attempt > 1))) {
        flags.push('RETRY');
    }
    if (rs.some((r) => r.calls.some((c) => c.stopReason === 'max_tokens'))) {
        flags.push('MAX_TOKENS');
    }
    if (errs) {
        flags.push(`${errs} failed`);
    }
    const cost = rs.map((r) => sum(r.calls.map((c) => c.costUsd ?? 0)));
    console.log(
        `| ${label} | ${avg(rs.map((r) => r.calls.length)).toFixed(1)} | ${Math.round(avg(rs.map((r) => sum(r.calls.map((c) => c.inputTokens)))))} | ${Math.round(avg(rs.map((r) => sum(r.calls.map((c) => c.outputTokens)))))} | ${Math.round(avg(rs.map((r) => sum(r.calls.map((c) => c.cacheWriteTokens)))))}/${Math.round(avg(rs.map((r) => sum(r.calls.map((c) => c.cacheReadTokens)))))} | ${usd(avg(cost))} (${usd(Math.min(...cost))}-${usd(Math.max(...cost))}) | ${flags.join(' ')} |`,
    );
}
console.log(
    `\nTotal spent in this run (estimated from usage): ${usd(sum(rows.flatMap((r) => r.calls.map((c) => c.costUsd ?? 0))))}`,
);
const out = opt('out');
if (out) {
    writeFileSync(out, JSON.stringify(rows, null, 2));
}
process.exit(0);
