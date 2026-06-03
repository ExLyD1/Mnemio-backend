import { env } from '../config/env.js';
import * as srsRepo from '../repositories/srs.repository.js';
import * as activityRepo from '../repositories/activity.repository.js';
import { mockProvider } from './ai.provider.mock.js';
import type { AiProvider } from './ai.provider.js';
import type { GenerateDeckInput, SuggestInput } from '../schemas/ai.schema.js';

const selectProvider = (): AiProvider => {
    // Add real providers (anthropic, openai, etc.) by importing them and
    // returning here. The mock keeps the FE unblocked.
    if (env.AI_PROVIDER === 'mock') return mockProvider;
    return mockProvider;
};

const provider = selectProvider();

export const generateDeck = (input: GenerateDeckInput) => provider.generateDeck(input);

const computeStreak = (rows: { date: Date; reviews: number }[]): number => {
    if (rows.length === 0) return 0;
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const active = new Set(rows.filter((r) => r.reviews > 0).map((r) => iso(r.date)));
    const cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    if (!active.has(iso(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
    let streak = 0;
    while (active.has(iso(cursor))) {
        streak += 1;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return streak;
};

export const suggest = async (userId: string, input: SuggestInput) => {
    const [dueCount, days] = await Promise.all([
        srsRepo.countDueCards(userId),
        activityRepo.allDays(userId),
    ]);
    const streak = computeStreak(days);

    const args: {
        context: SuggestInput['context'];
        deckId?: string;
        dueCount: number;
        streak: number;
    } = {
        context: input.context,
        dueCount,
        streak,
    };
    if (input.deckId !== undefined) args.deckId = input.deckId;
    return provider.suggest(args);
};

export const providerName = (): string => provider.name;
