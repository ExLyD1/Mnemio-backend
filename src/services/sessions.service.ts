import * as sessionsRepo from '../repositories/sessions.repository.js';
import * as decksRepo from '../repositories/decks.repository.js';
import * as achievementsService from './achievements.service.js';
import * as milestone from './milestone.service.js';
import { BadRequestError, NotFoundError } from '../shared/errors.js';
import { toPublicSession, type PublicSession } from '../shared/mappers.session.js';
import type { CreateSessionInput, UpdateSessionInput } from '../schemas/session.schema.js';

// XP formula (locked by frontend plan): correct * 10 + (completed ? 25 : 0).
// Server is authoritative — clients cannot supply xp.
export const computeXp = (correct: number, completed: boolean): number =>
    correct * 10 + (completed ? 25 : 0);

export const start = async (
    ownerId: string,
    input: CreateSessionInput,
): Promise<PublicSession> => {
    // Owners study their own decks; anyone may study a public deck. The session
    // row itself belongs to the requester (userId = ownerId), so a viewer's
    // session never touches the owner's data. Private decks 404 for non-owners.
    const deck = await decksRepo.findDeckByIdUnscoped(input.deckId);
    if (!deck || (deck.authorId !== ownerId && !deck.isPublic)) {
        throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');
    }

    const cards = await sessionsRepo.listDeckCardIds(input.deckId);
    if (cards.length === 0) {
        throw new BadRequestError('DECK_EMPTY', 'Cannot start a session on an empty deck');
    }

    const session = await sessionsRepo.startSession({
        userId: ownerId,
        deckId: input.deckId,
        mode: input.mode,
        cardIds: cards.map((c) => c.id),
    });
    return toPublicSession(session);
};

export const updateProgress = async (
    ownerId: string,
    sessionId: string,
    input: UpdateSessionInput,
): Promise<PublicSession> => {
    const patch: sessionsRepo.SessionProgressPatch = {};
    if (input.cardIndex !== undefined) patch.cardIndex = input.cardIndex;
    if (input.correct !== undefined) patch.correct = input.correct;
    if (input.counts !== undefined) {
        patch.countsAgain = input.counts.again;
        patch.countsHard = input.counts.hard;
        patch.countsGood = input.counts.good;
        patch.countsEasy = input.counts.easy;
    }
    if (input.revisitCardIds !== undefined) patch.revisitCardIds = input.revisitCardIds;
    if (input.durationMs !== undefined) patch.durationMs = input.durationMs;

    const { count } = await sessionsRepo.updateProgress(sessionId, ownerId, patch);
    if (count === 0) {
        throw new NotFoundError('SESSION_NOT_FOUND', 'Active session not found');
    }
    const fresh = await sessionsRepo.findSessionOwned(sessionId, ownerId);
    if (!fresh) throw new NotFoundError('SESSION_NOT_FOUND', 'Session not found');
    return toPublicSession(fresh);
};

export const complete = async (
    ownerId: string,
    sessionId: string,
): Promise<PublicSession> => {
    const session = await sessionsRepo.findSessionOwned(sessionId, ownerId);
    if (!session) throw new NotFoundError('SESSION_NOT_FOUND', 'Session not found');
    if (session.status !== 'active') {
        throw new BadRequestError('SESSION_NOT_ACTIVE', 'Session is not active');
    }

    const xp = computeXp(session.correct, true);
    const cardsStudied = session.cardIds.length;
    const correctAnswers = session.correct;

    const { count } = await sessionsRepo.completeSession(sessionId, ownerId, {
        xpAwarded: xp,
        cardsStudied,
        correctAnswers,
        cardIndex: cardsStudied,
        correct: correctAnswers,
    });
    if (count === 0) {
        throw new BadRequestError('SESSION_NOT_ACTIVE', 'Session was no longer active');
    }
    await sessionsRepo.incrementUserXp(ownerId, xp);

    // Fire-and-don't-fail achievement evaluation. The session response shape is
    // unchanged — newly-earned keys surface on the next GET /achievements.
    achievementsService.evaluate(ownerId, 'session_complete').catch(() => {
        // Swallow: achievement-system errors must not break session completion.
    });

    void milestone.checkFirstSession(ownerId);

    const fresh = await sessionsRepo.findSessionOwned(sessionId, ownerId);
    return toPublicSession(fresh!);
};

export const latestIncomplete = async (ownerId: string): Promise<PublicSession | null> => {
    const session = await sessionsRepo.findLatestIncomplete(ownerId);
    return session ? toPublicSession(session) : null;
};

export const active = async (ownerId: string): Promise<PublicSession | null> => {
    const session = await sessionsRepo.findActiveSession(ownerId);
    return session ? toPublicSession(session) : null;
};

export const exit = async (ownerId: string, sessionId: string): Promise<PublicSession> => {
    const { count } = await sessionsRepo.exitSession(sessionId, ownerId);
    if (count === 0) {
        throw new NotFoundError('SESSION_NOT_FOUND', 'Active session not found');
    }
    const fresh = await sessionsRepo.findSessionOwned(sessionId, ownerId);
    return toPublicSession(fresh!);
};

export const resume = async (ownerId: string, sessionId: string): Promise<PublicSession> => {
    const count = await sessionsRepo.resumeSession(sessionId, ownerId);
    if (count === 0) {
        throw new NotFoundError('SESSION_NOT_FOUND', 'Incomplete session not found');
    }
    const fresh = await sessionsRepo.findSessionOwned(sessionId, ownerId);
    return toPublicSession(fresh!);
};
