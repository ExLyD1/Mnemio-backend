import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { apkgTooLarge } from './imports.apkg.binary.js';
import { parseApkg } from './imports.apkg.js';
import { mediaMime } from './imports.apkg.media.js';
import { MIME_ALLOWLIST } from '../schemas/media.schema.js';
import type { ImportApkgInput } from '../schemas/imports.schema.js';
import * as budget from './ai.budget.service.js';
import * as media from './media.service.js';
import * as repo from '../repositories/imports.repository.js';
import * as achievements from './achievements.service.js';
import * as milestone from './milestone.service.js';

export const importApkg = async (userId: string, bytes: Buffer, languages: ImportApkgInput) => {
    if (bytes.length > env.IMPORT_APKG_MAX_BYTES) {
        apkgTooLarge('Package exceeds upload limit');
    }
    await budget.assertWithinBudget(userId, 'import');
    const parsed = await parseApkg(bytes);
    const stored: media.StoredFile[] = [],
        urls = new Map<string, string>();
    let mediaBytes = 0;
    let committed = false;
    try {
        const used = new Map<string, 'card_image' | 'card_audio'>();
        for (const deck of parsed.decks) {
            for (const card of deck.cards) {
                if (card.imageName) {
                    used.set(card.imageName, 'card_image');
                }
                if (card.audioName) {
                    used.set(card.audioName, 'card_audio');
                }
            }
        }
        for (const [name, kind] of used) {
            const load = parsed.media.get(name);
            if (!load) {
                continue;
            }
            const data = load();
            const mimeType = mediaMime(data, name);
            if (!mimeType || !MIME_ALLOWLIST[kind].test(mimeType)) {
                parsed.warnings.push(`media_skipped: ${name} unsupported type`);
                continue;
            }
            if (mediaBytes + data.length > 200_000_000) {
                parsed.warnings.push(`media_skipped: ${name} total upload limit`);
                continue;
            }
            try {
                const file = await media.storeBuffer(userId, kind, data, mimeType);
                stored.push(file);
                urls.set(name, file.url);
                mediaBytes += data.length;
            } catch (err) {
                if (
                    err instanceof AppError &&
                    (err.code === 'MEDIA_TOO_LARGE' || err.code === 'MEDIA_BAD_MIME')
                ) {
                    parsed.warnings.push(`media_skipped: ${name} ${err.code.toLowerCase()}`);
                } else {
                    throw err;
                }
            }
        }
        const decks = await repo.createApkgDecks(
            userId,
            languages,
            parsed.decks.map((deck) => ({
                title: deck.title,
                description: deck.description,
                sourceData: deck.sourceData,
                cards: deck.cards.map((card) => ({
                    word: card.word,
                    definition: card.definition,
                    tags: card.tags,
                    type: card.type,
                    reading: card.reading,
                    phonetic: card.phonetic,
                    example: card.example,
                    exampleTranslation: card.exampleTranslation,
                    partOfSpeech: card.partOfSpeech,
                    imageUrl: card.imageName ? (urls.get(card.imageName) ?? null) : null,
                    audioUrl: card.audioName ? (urls.get(card.audioName) ?? null) : null,
                    sourceData: card.sourceData,
                })),
            })),
        );
        committed = true;
        await budget.recordUse(userId, 'import');
        void milestone.checkFirstDeck(userId);
        const newAchievements = await achievements.evaluate(userId, 'card_create').catch(() => []);
        return {
            decks,
            cardsImported: decks.reduce((sum, d) => sum + d.cardCount, 0),
            cardsSkipped: parsed.cardsSkipped,
            mediaImported: stored.length,
            warnings: parsed.warnings,
            newAchievements,
        };
    } finally {
        if (!committed) {
            await Promise.all(stored.map((file) => media.removeStoredFile(userId, file)));
        }
    }
};
