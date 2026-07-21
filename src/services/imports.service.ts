import { env } from '../config/env.js';
import {
    ImportBadUrlError,
    ImportNotFoundError,
    ImportParseFailedError,
    ImportUpstreamError,
} from '../shared/errors.js';
import {
    extractFromQuizletHtml,
    parseQuizletUrl,
    type QuizletExtractResult,
} from './imports.quizlet.js';
import { parseText, type TextFormat, type TextParseResult } from './imports.text.js';
import * as budget from './ai.budget.service.js';

export type QuizletImportResult = {
    source: { kind: 'quizlet'; setId: string; title: string };
    cards: QuizletExtractResult['cards'];
};

export type TextImportResult = {
    source: { kind: 'text'; format: TextParseResult['format'] };
    cards: TextParseResult['cards'];
};

const USER_AGENT = 'Mnemio-Importer/1.0 (+https://mnemio.app)';

const fetchQuizletHtml = async (setId: string): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.IMPORT_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`https://quizlet.com/${setId}`, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
            signal: controller.signal,
        });
        if (res.status === 404) throw new ImportNotFoundError();
        if (!res.ok) throw new ImportUpstreamError(res.status);

        // Cap the response body so a misconfigured upstream can't OOM us.
        const reader = res.body?.getReader();
        if (!reader) {
            // No body — treat as parse failure.
            throw new ImportParseFailedError();
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > env.IMPORT_MAX_BYTES) {
                // Abort the stream; we don't trust the rest.
                await reader.cancel();
                throw new ImportUpstreamError(res.status, 'Upstream response exceeded size cap');
            }
            chunks.push(value);
        }
        return new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    } catch (err) {
        if ((err as Error).name === 'AbortError') {
            throw new ImportUpstreamError(504, 'Upstream fetch timed out');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
};

export const importQuizletByUrl = async (
    userId: string,
    rawUrl: string,
): Promise<QuizletImportResult> => {
    const parsed = parseQuizletUrl(rawUrl);
    if (!parsed) throw new ImportBadUrlError();

    await budget.assertWithinBudget(userId, 'import');

    const html = await fetchQuizletHtml(parsed.setId);
    const extracted = extractFromQuizletHtml(html, parsed.setId);
    if (!extracted) throw new ImportParseFailedError();

    await budget.recordUse(userId, 'import');
    return {
        source: { kind: 'quizlet', setId: extracted.setId, title: extracted.title },
        cards: extracted.cards,
    };
};

export const importByText = async (
    userId: string,
    text: string,
    format: TextFormat = 'auto',
): Promise<TextImportResult> => {
    // Cheap, no upstream call — but we still budget so a user can't run away
    // with thousands of paste-imports a day.
    await budget.assertWithinBudget(userId, 'import');

    const parsed = parseText(text, format);
    if (parsed.cards.length === 0) {
        throw new ImportParseFailedError('No card pairs could be parsed from the input');
    }

    await budget.recordUse(userId, 'import');
    return {
        source: { kind: 'text', format: parsed.format },
        cards: parsed.cards,
    };
};
