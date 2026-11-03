/**
 * AI cost calibration: runs each operation through the REAL provider code
 * (real prompts from ai.prompts.ts / chat.prompt.ts, tools, retries) and
 * records every API call it triggers. Nothing is written to the database —
 * chat tools run their real generation calls, only persistence is stubbed.
 *
 *   npx tsx --env-file=.env scripts/ai-calibrate.ts                 # dry run: lists cells, spends nothing
 *   npx tsx --env-file=.env scripts/ai-calibrate.ts --run --arm today \
 *       --model claude-haiku-4-5-20251001 --effort off --uk-model claude-sonnet-5
 *   ... --only enrich_100,photo --lang uk --runs 3 --out out/today.jsonl
 *   ... --build-history          # once: freeze the chat history fixture
 *
 * Flags:
 *   --model M        every route (chat, tips, EN + UK content, photo)
 *   --effort E       off | low | medium | high, for every route
 *   --uk-model M     override the UK content route (and UK photo)
 *   --uk-effort E    effort for the UK route (defaults to --effort)
 *   --only a,b       cells whose op starts with one of these (chat, enrich_100, …)
 *   --lang en|uk     one column only
 *   --runs N         runs per cell (default 3; photo = one run per photo)
 *   --concurrency N  cells in flight at once (default 3)
 *   --budget-usd X   stop before the eval's cumulative spend could pass X (default 5)
 *   --out FILE       JSONL with every ai_call line and every run's raw output
 *   --prompt-rules F eval-only: insert the rules in F into the emit_cards / emit_deck
 *                    system prompt (production prompts are not changed)
 *   --photo-runs N   passes over the photo set (default 1; photo runs = photos × N)
 *
 * The API key comes from .env and is never printed. Use a dev key.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import {
    FIXTURES,
    Ledger,
    OUT,
    appendJsonl,
    pool,
    readJson,
    type ChatHistory,
    type ChatScript,
    type Lang,
    type QualitySet,
} from './ai-eval/lib.js';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};

// Route the models before env.ts is imported (ESM hoists static imports, so
// everything that reads env is imported dynamically below).
process.env['AI_PROVIDER'] = 'anthropic';
const model = opt('model');
const effort = opt('effort');
if (model) {
    for (const k of [
        'ANTHROPIC_MODEL',
        'ANTHROPIC_CONTENT_MODEL_EN',
        'ANTHROPIC_CONTENT_MODEL_UK',
    ]) {
        process.env[k] = model;
    }
}
if (effort) {
    for (const k of [
        'ANTHROPIC_CHAT_EFFORT',
        'ANTHROPIC_CONTENT_EFFORT_EN',
        'ANTHROPIC_CONTENT_EFFORT_UK',
    ]) {
        process.env[k] = effort;
    }
}
const ukModel = opt('uk-model');
if (ukModel) {
    process.env['ANTHROPIC_CONTENT_MODEL_UK'] = ukModel;
}
const ukEffort = opt('uk-effort');
if (ukEffort) {
    process.env['ANTHROPIC_CONTENT_EFFORT_UK'] = ukEffort;
}
// Photo follows the content route for its languages.
process.env['ANTHROPIC_PHOTO_MODEL'] = '';

const { anthropicProvider } = await import('../src/services/ai.provider.anthropic.js');
const aiService = await import('../src/services/ai.service.js');
const chatTools = await import('../src/services/chat.tools.js');
const { buildChatSystemPrompt } = await import('../src/services/chat.prompt.js');
const { setAiCallListener } = await import('../src/services/ai.usage-log.js');
const { chatRoute, contentRoute } = await import('../src/services/ai.models.js');
const { AppError } = await import('../src/shared/errors.js');
const { env } = await import('../src/config/env.js');
import type { AiCallRecord } from '../src/services/ai.usage-log.js';
import type {
    AiCardDraft,
    AiImageInput,
    ChatToolOutcome,
    ChatToolsConfig,
    ChatTurn,
} from '../src/services/ai.provider.js';
import type { AddCardsToolInput, CreateDeckToolInput } from '../src/services/chat.tools.js';
import type { ChatBudgetContext, ChatDeckContext } from '../src/services/chat.prompt.js';

// ---------- eval-only prompt variant ----------

// Wraps the SDK's stream() for this process only: the real provider path (retries,
// max_tokens, effort) still runs, and ai.prompts.ts is untouched.
const patchStats = { generatorCalls: 0, patched: 0 };
const rulesArg = opt('prompt-rules');
if (rulesArg) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const rules = readFileSync(
        isAbsolute(rulesArg) ? rulesArg : join(FIXTURES, rulesArg),
        'utf8',
    ).trim();
    type StreamBody = {
        system?: string | { type: string; text?: string }[];
        tools?: { name: string }[];
    };
    const proto = Anthropic.Messages.prototype as unknown as {
        stream: (body: StreamBody, options?: unknown) => unknown;
    };
    const original = proto.stream;
    // "Call the emit_cards tool exactly once with all entries." / "…emit_deck tool exactly once."
    const ANCHOR = /\nCall the emit_(?:cards|deck) tool exactly once/;
    proto.stream = function (this: unknown, body: StreamBody, options?: unknown) {
        const toolName = body.tools?.[0]?.name ?? '';
        if (!/^emit_(cards|deck)$/.test(toolName)) {
            return original.call(this, body, options);
        }
        patchStats.generatorCalls++;
        const blocks = Array.isArray(body.system) ? body.system : [];
        const last = blocks[blocks.length - 1];
        if (!last?.text || !ANCHOR.test(last.text)) {
            throw new Error('prompt-rules: closing "Call the emit_… tool" line not found');
        }
        const text = last.text.replace(ANCHOR, (m) => `\n${rules}\n${m}`);
        patchStats.patched++;
        const system = [...blocks.slice(0, -1), { ...last, text }];
        return original.call(this, { ...body, system }, options);
    };
}

const RUNS = Number(opt('runs') ?? 3);
const PHOTO_PASSES = Number(opt('photo-runs') ?? 1);
const CONCURRENCY = Number(opt('concurrency') ?? 3);
const BUDGET = Number(opt('budget-usd') ?? 5);
const OUT_FILE = (() => {
    const o = opt('out') ?? 'out/calibration.jsonl';
    return isAbsolute(o) ? o : join(FIXTURES, o);
})();
const ARM =
    opt('arm') ??
    [model ?? 'env', effort ?? '', ukModel ? `uk=${ukModel}` : ''].filter(Boolean).join('@');

const quality = readJson<QualitySet>('quality-set.json');
const scripts = readJson<Record<Lang, ChatScript>>('chat-scripts.json');
const scenarios = readJson<{
    topic: { topic: string; count: number };
    tip: { context: 'dashboard'; dueCount: number; streak: number };
    photo: { count: number };
}>('scenarios.json');

// A free user with a full day's allowance — what the chat prompt shows most of the time.
const BUDGET_CTX: ChatBudgetContext = {
    decksRemaining: 2,
    decksCap: env.MIMI_DECKS_PER_DAY_FREE,
    actionsRemaining: 5,
    actionsCap: env.MIMI_ACTIONS_PER_DAY_FREE,
    resetsAt: '2026-10-28T00:00:00.000Z',
    plan: 'free',
};
const EVAL_USER = 'ai-eval';
// Definitions language per column; the words are always English (see scenarios.json).
const defsLang = (lang: Lang) => lang;

// ---------- chat tools: real generation, stubbed persistence ----------

type Generated = { tool: string; cards: AiCardDraft[]; title?: string } | null;

// Same JSON chat.service hands the model as the tool_result (toOutcome there).
const okOutcome = (attachment: Record<string, unknown>, words: string[], skipped: string[] = []) =>
    ({
        ok: true,
        data: attachment,
        resultJson: JSON.stringify({
            ok: true,
            ...attachment,
            wordsLanguage: attachment['targetLanguage'],
            definitionsLanguage: attachment['sourceLanguage'],
            words,
            ...(skipped.length > 0 ? { skipped } : {}),
        }),
    }) as ChatToolOutcome;

const failOutcome = (reason: string, details?: Record<string, unknown>): ChatToolOutcome => ({
    ok: false,
    data: { reason },
    resultJson: JSON.stringify({ ok: false, reason, ...(details ? { details } : {}) }),
});

const compareKey = (s: string) =>
    s
        .toLowerCase()
        .replace(/[«»"'`’‘”“]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

const evalTools = (
    script: ChatScript,
    deck: ChatDeckContext | undefined,
    sink: { generated: Generated },
): ChatToolsConfig => ({
    defs: deck
        ? [chatTools.CREATE_DECK_TOOL_DEF, chatTools.ADD_CARDS_TOOL_DEF]
        : [chatTools.CREATE_DECK_TOOL_DEF],
    run: async (call) => {
        try {
            if (call.name === 'create_deck') {
                const input = call.input as CreateDeckToolInput;
                const words = input.words?.length ? input.words : null;
                const topic = input.topic?.trim() ? input.topic : null;
                if (!words && !topic) {
                    return failOutcome(
                        'create_deck needs either a `topic` or a non-empty `words` list',
                    );
                }
                const langs = chatTools.resolveDeckLanguages({
                    wordsLanguage: input.wordsLanguage,
                    definitionsLanguage: input.definitionsLanguage,
                    userLangs: script.userLangs,
                    locale: script.locale,
                });
                if (!langs.ok) {
                    return failOutcome(langs.reason, langs.details);
                }
                const { sourceLanguage, targetLanguage } = langs;
                const draft = words
                    ? await aiService.fillCards({ words, sourceLanguage, targetLanguage })
                    : await chatTools.generateDeckWithRetry(EVAL_USER, {
                          topic: topic ?? '',
                          sourceLanguage,
                          targetLanguage,
                          ...(input.count ? { count: input.count } : {}),
                      });
                const title = input.title ?? ('title' in draft ? draft.title : 'Vocabulary deck');
                sink.generated = { tool: 'create_deck', cards: draft.cards, title };
                return okOutcome(
                    {
                        type: 'deck',
                        deckId: 'eval-deck',
                        title,
                        cardCount: draft.cards.length,
                        action: 'created',
                        sourceLanguage,
                        targetLanguage,
                    },
                    draft.cards.map((c) => c.word),
                );
            }
            if (call.name === 'add_cards' && deck) {
                const input = call.input as AddCardsToolInput;
                const existing = script.openDeck.words;
                const keys = new Set(existing.map(compareKey));
                const words = input.words?.length ? input.words : null;
                const fresh = words?.filter((w) => !keys.has(compareKey(w))) ?? null;
                if (words && fresh?.length === 0) {
                    return failOutcome('ALL_DUPLICATES', { deck: deck.title, skipped: words });
                }
                const drafts = fresh
                    ? (
                          await aiService.fillCards({
                              words: fresh,
                              sourceLanguage: deck.sourceLanguage,
                              targetLanguage: deck.targetLanguage,
                          })
                      ).cards
                    : (
                          await chatTools.generateDeckWithRetry(EVAL_USER, {
                              topic: input.topic ?? '',
                              sourceLanguage: deck.sourceLanguage,
                              targetLanguage: deck.targetLanguage,
                              ...(input.count ? { count: input.count } : {}),
                              exclude: existing,
                          })
                      ).cards;
                const cards = drafts.filter((c) => !keys.has(compareKey(c.word)));
                sink.generated = { tool: 'add_cards', cards };
                return okOutcome(
                    {
                        type: 'deck',
                        deckId: 'eval-open-deck',
                        title: deck.title,
                        cardCount: existing.length + cards.length,
                        action: 'appended',
                        addedCount: cards.length,
                        sourceLanguage: deck.sourceLanguage,
                        targetLanguage: deck.targetLanguage,
                    },
                    cards.map((c) => c.word),
                );
            }
            return failOutcome('UNKNOWN_TOOL');
        } catch (err) {
            // Mirrors chat.tools' toFailure: AppError codes reach the model.
            return failOutcome(err instanceof AppError ? err.code : 'INTERNAL', {
                retryable: false,
            });
        }
    },
});

// What chat.service sends: the last AI_CHAT_CONTEXT_TURNS - 1 complete messages
// (lastTurnsForModel, trailing user turns dropped), then the new user turn.
const contextFor = (history: { user: string; assistant: string }[], turn: number): ChatTurn[] => {
    const prior: ChatTurn[] = history
        .slice(0, turn - 1)
        .flatMap((h) => [
            { role: 'user' as const, content: h.user },
            { role: 'assistant' as const, content: h.assistant },
        ])
        .slice(-(env.AI_CHAT_CONTEXT_TURNS - 1));
    while (prior.at(-1)?.role === 'user') {
        prior.pop();
    }
    return prior;
};

// ---------- cells ----------

type Cell = {
    op: string;
    lang: Lang;
    label: string;
    // Run index → raw output to keep for grading.
    run: (i: number) => Promise<unknown>;
    runs: number;
    // Expected card count, for the grader.
    expectCards?: number;
};

const cells: Cell[] = [];
const langs: Lang[] = opt('lang') ? [opt('lang') as Lang] : ['en', 'uk'];

const loadHistory = (): ChatHistory | null => {
    try {
        return readJson<ChatHistory>('chat-history.json');
    } catch {
        return null;
    }
};
const history = loadHistory();

for (const lang of langs) {
    const script = scripts[lang];
    const system = (deck?: ChatDeckContext) =>
        buildChatSystemPrompt(deck, script.locale, false, script.userLangs, BUDGET_CTX);
    const chat = async (messages: ChatTurn[], deck?: ChatDeckContext) => {
        const sink: { generated: Generated } = { generated: null };
        const result = await anthropicProvider.chat({
            messages,
            systemPrompt: system(deck),
            maxOutputTokens: env.AI_CHAT_MAX_OUTPUT_TOKENS,
            tools: evalTools(script, deck, sink),
        });
        return {
            content: result.content,
            attachments: result.attachments,
            generated: sink.generated,
        };
    };

    for (const turn of [1, 10, 30]) {
        cells.push({
            op: `chat_turn${turn}`,
            lang,
            label: `chat message, turn ${turn} [${lang}]`,
            runs: RUNS,
            run: () => {
                if (turn > 1 && !history) {
                    throw new Error('chat-history.json missing — run --build-history first');
                }
                const prior = history ? contextFor(history[lang], turn) : [];
                const text = script.userTurns[turn - 1] ?? '';
                return chat([...prior, { role: 'user', content: text }]);
            },
        });
    }
    cells.push({
        op: 'chat_create_deck',
        lang,
        label: `chat: create a 20-card deck [${lang}]`,
        runs: RUNS,
        expectCards: 20,
        run: () => chat([{ role: 'user', content: script.createDeck }]),
    });
    const openDeck: ChatDeckContext = {
        deckId: 'eval-open-deck',
        title: script.openDeck.title,
        sourceLanguage: script.openDeck.sourceLanguage,
        targetLanguage: script.openDeck.targetLanguage,
    };
    cells.push({
        op: 'chat_add_cards',
        lang,
        label: `chat: add 10 cards [${lang}]`,
        runs: RUNS,
        expectCards: 10,
        run: () => chat([{ role: 'user', content: script.addCards }], openDeck),
    });
    for (const n of ['1', '10', '50', '100'] as const) {
        const words = quality.lists[n];
        cells.push({
            op: `enrich_${n}`,
            lang,
            label: `word list → deck, ${n} word${n === '1' ? '' : 's'} [${lang}]`,
            runs: RUNS,
            // fillCards = prepareWords (dedupe) + the provider, as in production.
            run: () =>
                aiService.fillCards({
                    words,
                    sourceLanguage: defsLang(lang),
                    targetLanguage: 'en',
                }),
        });
    }
    cells.push({
        op: 'topic_20',
        lang,
        label: `topic → deck, 20 cards [${lang}]`,
        runs: RUNS,
        expectCards: scenarios.topic.count,
        run: () =>
            aiService.draftDeck(EVAL_USER, {
                topic: scenarios.topic.topic,
                sourceLanguage: defsLang(lang),
                targetLanguage: 'en',
                count: scenarios.topic.count,
            }),
    });
    const photoDir = join(FIXTURES, 'photos');
    const photos = readdirSync(photoDir).filter((f) =>
        ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(f).toLowerCase()),
    );
    if (photos.length > 0) {
        cells.push({
            op: 'photo',
            lang,
            label: `photo → deck [${lang}]`,
            runs: photos.length * PHOTO_PASSES,
            run: (i) => {
                const file = photos[i % photos.length] ?? '';
                const ext = extname(file).toLowerCase();
                const image: AiImageInput = {
                    mediaType:
                        ext === '.png'
                            ? 'image/png'
                            : ext === '.webp'
                              ? 'image/webp'
                              : 'image/jpeg',
                    dataBase64: readFileSync(join(photoDir, file)).toString('base64'),
                };
                return anthropicProvider
                    .deckFromImage({
                        sourceLanguage: defsLang(lang),
                        count: scenarios.photo.count,
                        image,
                    })
                    .then((draft) => ({ photo: file, draft }));
            },
        });
    }
    // The tip prompt has no language: one cell serves both columns.
    if (lang === langs[0]) {
        cells.push({
            op: 'tip',
            lang,
            label: 'tip (suggest) [both]',
            runs: RUNS,
            run: () => anthropicProvider.suggest(scenarios.tip),
        });
    }
}

const only = opt('only')?.split(',');
// A token matches its exact cell; a token that names no cell is a family
// prefix ("chat", "enrich"). So enrich_10 never pulls in enrich_100.
const matches = (op: string, token: string) =>
    op === token || (!cells.some((c) => c.op === token) && op.startsWith(token));
const selected = only ? cells.filter((c) => only.some((o) => matches(c.op, o))) : cells;

// Unknown cells are projected generously; known ones at their worst so far.
const DEFAULT_PROJECTION: Record<string, number> = {
    enrich_100: 0.4,
    enrich_50: 0.2,
    chat_create_deck: 0.15,
    chat_add_cards: 0.12,
    topic_20: 0.12,
    photo: 0.12,
};
const projection = (ledger: Ledger, key: string, op: string) =>
    ledger.lastCost(key) ?? DEFAULT_PROJECTION[op] ?? 0.05;

// ---------- build the chat history fixture ----------

if (flag('build-history')) {
    if (!flag('run')) {
        console.log('Add --run to build chat-history.json (spends a few cents).');
        process.exit(0);
    }
    const ledger = new Ledger(BUDGET);
    const spent: number[] = [];
    setAiCallListener((r) => spent.push(r.costUsd ?? 0));
    const out: ChatHistory = {
        generatedBy: `${chatRoute().model}@${chatRoute().effort}`,
        generatedAt: new Date().toISOString(),
        en: [],
        uk: [],
    };
    await Promise.all(
        (['en', 'uk'] as const).map(async (lang) => {
            const script = scripts[lang];
            const systemPrompt = buildChatSystemPrompt(
                undefined,
                script.locale,
                false,
                script.userLangs,
                BUDGET_CTX,
            );
            // 29 exchanges are enough context for turn 30.
            for (const user of script.userTurns.slice(0, 29)) {
                const prior = contextFor(out[lang], out[lang].length + 1);
                const r = await anthropicProvider.chat({
                    messages: [...prior, { role: 'user', content: user }],
                    systemPrompt,
                    maxOutputTokens: env.AI_CHAT_MAX_OUTPUT_TOKENS,
                });
                out[lang].push({ user, assistant: r.content });
                process.stderr.write('.');
            }
        }),
    );
    const cost = spent.reduce((a, b) => a + b, 0);
    ledger.reserve(0);
    ledger.settle('build-history', 0, cost);
    writeFileSync(join(FIXTURES, 'chat-history.json'), JSON.stringify(out, null, 2));
    console.log(
        `\nchat-history.json written (${out.en.length}+${out.uk.length} turns, $${cost.toFixed(4)}).`,
    );
    process.exit(0);
}

// ---------- dry run ----------

const routeLine = () => {
    const en = contentRoute('en');
    const uk = contentRoute('uk');
    const c = chatRoute();
    return `chat ${c.model}@${c.effort} · EN content ${en.model}@${en.effort} · UK content ${uk.model}@${uk.effort}`;
};

if (!flag('run')) {
    console.log(`Dry run, arm "${ARM}": ${routeLine()}`);
    for (const c of selected) {
        console.log(` - ${c.op.padEnd(18)} ${c.label} × ${c.runs}`);
    }
    if (!selected.some((c) => c.op === 'photo')) {
        console.log(' (no photo cells: scripts/fixtures/ai-eval/photos/ is empty)');
    }
    console.log('Add --run to spend API credits.');
    process.exit(0);
}
if (!env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exit(1);
}

// ---------- run ----------

type RunCtx = { calls: AiCallRecord[] };
const als = new AsyncLocalStorage<RunCtx>();
setAiCallListener((r) => als.getStore()?.calls.push(r));

const ledger = new Ledger(BUDGET);
// Set by any task that would pass the ceiling; later tasks then skip.
const state = { stopped: false };
console.error(`Arm "${ARM}": ${routeLine()}`);
console.error(`Budget $${BUDGET.toFixed(2)}, spent so far $${ledger.spentUsd.toFixed(4)}`);

const tasks = selected.flatMap((cell) =>
    Array.from({ length: cell.runs }, (_, i) => async () => {
        const key = `${ARM}|${cell.op}|${cell.lang}`;
        const projected = projection(ledger, key, cell.op);
        if (state.stopped || !ledger.reserve(projected)) {
            state.stopped = true;
            return;
        }
        const ctx: RunCtx = { calls: [] };
        const started = Date.now();
        const result: { output: unknown; error: { message: string; code?: string } | null } = {
            output: null,
            error: null,
        };
        await als.run(ctx, async () => {
            try {
                result.output = await cell.run(i);
            } catch (err) {
                result.error = {
                    message: (err as Error).message,
                    ...(err instanceof AppError ? { code: err.code } : {}),
                };
            }
        });
        const costUsd = ctx.calls.reduce((a, c) => a + (c.costUsd ?? 0), 0);
        ledger.settle(key, projected, costUsd);
        // `cell`, not `op`: each ai_call line keeps its own provider op (enrich, chat_round1, …).
        const tag = { arm: ARM, cell: cell.op, lang: cell.lang, run: i + 1 };
        for (const call of ctx.calls) {
            appendJsonl(OUT_FILE, { ...call, ...tag });
        }
        appendJsonl(OUT_FILE, {
            evt: 'run',
            ...tag,
            op: cell.op,
            label: cell.label,
            routes: routeLine(),
            expectCards: cell.expectCards ?? null,
            wallMs: Date.now() - started,
            calls: ctx.calls.length,
            costUsd,
            error: result.error,
            output: result.output,
        });
        process.stderr.write(result.error ? 'x' : '.');
    }),
);
await pool(CONCURRENCY, tasks);
process.stderr.write('\n');
if (rulesArg) {
    appendJsonl(OUT_FILE, { evt: 'patch', arm: ARM, ...patchStats });
    console.log(
        `prompt-rules: patched ${patchStats.patched} of ${patchStats.generatorCalls} generator calls`,
    );
    if (patchStats.patched === 0 || patchStats.patched !== patchStats.generatorCalls) {
        console.error(
            'prompt-rules: not every generator call carried the rules — discard this run.',
        );
        process.exit(3);
    }
}
console.log(
    `${state.stopped ? 'STOPPED at the budget ceiling. ' : ''}Eval spend so far: $${ledger.spentUsd.toFixed(4)} of $${BUDGET.toFixed(2)}. Output: ${OUT_FILE.replace(`${OUT}/`, 'out/')}`,
);
process.exit(state.stopped ? 2 : 0);
