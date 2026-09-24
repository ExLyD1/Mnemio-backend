import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as sessionsRepo from '../src/repositories/sessions.repository.js';
import * as decksRepo from '../src/repositories/decks.repository.js';
import { start } from '../src/services/sessions.service.js';
import { createSessionSchema } from '../src/schemas/session.schema.js';

vi.mock('../src/repositories/sessions.repository.js', async () => {
    const actual = await vi.importActual<typeof sessionsRepo>(
        '../src/repositories/sessions.repository.js',
    );
    return { ...actual, listDeckCardIds: vi.fn(), startSession: vi.fn() };
});

vi.mock('../src/repositories/decks.repository.js', async () => {
    const actual = await vi.importActual<typeof decksRepo>(
        '../src/repositories/decks.repository.js',
    );
    return { ...actual, findDeckByIdUnscoped: vi.fn() };
});

const mockedSessions = vi.mocked(sessionsRepo);
const mockedDecks = vi.mocked(decksRepo);

const DECK = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-1';
const ids = [
    '22222222-2222-4222-8222-222222222221',
    '22222222-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222223',
    '22222222-2222-4222-8222-222222222224',
];
const FOREIGN = '33333333-3333-4333-8333-333333333333';

const startedAs = () =>
    (mockedSessions.startSession.mock.calls[0]?.[0] as { cardIds: string[] }).cardIds;

describe('sessions.service / start — cardIds', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedDecks.findDeckByIdUnscoped.mockResolvedValue({
            id: DECK,
            authorId: OWNER,
            isPublic: false,
        } as never);
        mockedSessions.listDeckCardIds.mockResolvedValue(ids.map((id) => ({ id })) as never);
        mockedSessions.startSession.mockResolvedValue({
            id: 'sess-1',
            userId: OWNER,
            deckId: DECK,
            mode: 'flashcard',
            cardIds: [],
            index: 0,
            correct: 0,
            status: 'active',
            srsEnabled: false,
            durationMs: 0,
            countsAgain: 0,
            countsHard: 0,
            countsGood: 0,
            countsEasy: 0,
            revisitCardIds: [],
            startedAt: new Date(),
            endedAt: null,
            completedAt: new Date(),
            xpAwarded: 0,
            cardsStudied: 0,
            correctAnswers: 0,
        } as never);
    });

    // The regression: a 3-card "study unknown" round recorded the whole deck as
    // studied, and browse mode rolled that number straight into DailyActivity.
    it('records only the requested subset', async () => {
        await start(OWNER, {
            deckId: DECK,
            mode: 'flashcard',
            srsEnabled: false,
            cardIds: [ids[0]!, ids[2]!],
        });
        expect(startedAs()).toEqual([ids[0], ids[2]]);
    });

    it('preserves the client-supplied order (so resume replays the same order)', async () => {
        await start(OWNER, {
            deckId: DECK,
            mode: 'flashcard',
            srsEnabled: true,
            cardIds: [ids[3]!, ids[0]!, ids[2]!],
        });
        expect(startedAs()).toEqual([ids[3], ids[0], ids[2]]);
    });

    it('falls back to the whole deck when no cardIds are sent', async () => {
        await start(OWNER, { deckId: DECK, mode: 'flashcard', srsEnabled: true });
        expect(startedAs()).toEqual(ids);
    });

    it('silently drops ids that are not in this deck', async () => {
        await start(OWNER, {
            deckId: DECK,
            mode: 'flashcard',
            srsEnabled: true,
            cardIds: [ids[1]!, FOREIGN],
        });
        expect(startedAs()).toEqual([ids[1]]);
    });

    it('rejects a request made entirely of foreign card ids', async () => {
        await expect(
            start(OWNER, {
                deckId: DECK,
                mode: 'flashcard',
                srsEnabled: true,
                cardIds: [FOREIGN],
            }),
        ).rejects.toMatchObject({ code: 'SESSION_NO_CARDS' });
        expect(mockedSessions.startSession).not.toHaveBeenCalled();
    });
});

describe('session.schema / createSessionSchema', () => {
    it('accepts a request without cardIds (backwards compatible)', () => {
        const parsed = createSessionSchema.parse({ deckId: DECK, mode: 'flashcard' });
        expect(parsed.cardIds).toBeUndefined();
        expect(parsed.srsEnabled).toBe(true);
    });

    it('accepts cardIds', () => {
        const parsed = createSessionSchema.parse({
            deckId: DECK,
            mode: 'srs',
            cardIds: [ids[0]!],
        });
        expect(parsed.cardIds).toEqual([ids[0]]);
    });

    it('rejects non-uuid card ids', () => {
        expect(() =>
            createSessionSchema.parse({ deckId: DECK, mode: 'srs', cardIds: ['nope'] }),
        ).toThrow();
    });
});
