import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseApkg } from '../src/services/imports.apkg.js';
import { ApkgZip, ZIP_LIMITS } from '../src/services/imports.apkg.binary.js';
import {
    htmlToText,
    renderCard,
    renderCloze,
    renderTemplate,
} from '../src/services/imports.apkg.render.js';

const fixture = (file: string) =>
    readFileSync(new URL(`./fixtures/anki/${file}.apkg`, import.meta.url));
describe('real Anki exports', () => {
    it.each(['modern', 'legacy', 'anki2-only'])(
        '%s renders identical card content and preserves source',
        async (file) => {
            const result = await parseApkg(fixture(file));
            expect(result.cardsSkipped).toBe(0);
            expect(result.warnings).toEqual([]);
            expect(result.decks.map((d) => [d.title, d.cards.length]).sort()).toEqual([
                ['Languages › German', 3],
                ['Languages › Japanese', 5],
            ]);
            const japanese = result.decks.find((d) => d.title.endsWith('Japanese'));
            const german = result.decks.find((d) => d.title.endsWith('German'));
            expect(japanese?.cards.map((c) => [c.word, c.definition, c.type, c.tags])).toEqual([
                ['猫 (ねこ)', 'cat\na small animal', 'basic', ['animals', 'jlpt::n5']],
                [
                    'The [...] sat on the mat.',
                    'The cat sat on the mat.\nclassic',
                    'cloze',
                    ['cloze'],
                ],
                [
                    'The cat sat on the [floor covering].',
                    'The cat sat on the mat.\nclassic',
                    'cloze',
                    ['cloze'],
                ],
                ['水\nみず', 'water\n水を飲む', 'basic', ['vocab']],
                ['火', 'fire', 'basic', []],
            ]);
            expect(japanese?.cards[0]).toMatchObject({
                imageName: 'cat.png',
                audioName: 'cat.mp3',
            });
            expect(japanese?.cards[3]).toMatchObject({
                reading: 'みず',
                example: '水を飲む',
                exampleTranslation: 'to drink water',
                partOfSpeech: 'noun',
                sourceData: { anki: { fields: { Notes: '<div>secret extra</div>' } } },
            });
            expect(german?.cards.map((c) => [c.word, c.definition])).toEqual([
                ['Hund', 'dog & puppy'],
                ['dog & puppy', 'Hund'],
                ['Haus', 'house'],
            ]);
            for (const deck of result.decks) {
                expect(deck.sourceData).toMatchObject({
                    anki: { notetypes: expect.any(Array) },
                    mediaFiles: expect.arrayContaining(['cat.png', 'cat.mp3']),
                    package: {
                        file:
                            file === 'modern'
                                ? 'collection.anki21b'
                                : file === 'legacy'
                                  ? 'collection.anki21'
                                  : 'collection.anki2',
                    },
                });
            }
            const card = japanese?.cards[0];
            expect(card?.sourceData).toMatchObject({
                anki: {
                    guid: expect.any(String),
                    scheduling: { reps: 2 },
                    revlog: expect.any(Array),
                    questionHtml: expect.any(String),
                    answerHtml: expect.any(String),
                },
            });
            expect(result.media.get('cat.png')?.().subarray(0, 4)).toEqual(
                Buffer.from([137, 80, 78, 71]),
            );
            expect(result.media.get('cat.mp3')?.().length).toBeGreaterThan(0);
        },
    );
    it('rejects non-ZIP and corrupt input', async () => {
        await expect(parseApkg(Buffer.from('hello'))).rejects.toMatchObject({
            code: 'IMPORT_APKG_INVALID',
            statusCode: 400,
        });
        const bad = Buffer.from(fixture('legacy'));
        bad[100] ^= 1;
        await expect(parseApkg(bad)).rejects.toMatchObject({ code: 'IMPORT_APKG_INVALID' });
    });
    it('guards entry count, per-entry size and aggregate size before decompressing', () => {
        const bytes = fixture('modern');
        for (const limits of [
            { ...ZIP_LIMITS, entries: 1 },
            { ...ZIP_LIMITS, entryBytes: 1 },
            { ...ZIP_LIMITS, totalBytes: 1 },
        ]) {
            expect(() => new ApkgZip(bytes, limits)).toThrowError(
                expect.objectContaining({ code: 'IMPORT_APKG_TOO_LARGE', statusCode: 413 }),
            );
        }
    });
});
describe('template subset', () => {
    it('handles nested conditional and inverted sections, special fields and filters', () => {
        expect(
            renderTemplate('{{#A}}a{{#B}}{{text:B}}{{/B}}{{^C}}c{{/C}}{{/A}} {{Deck}}', {
                fields: { A: 'yes', B: '<b>b</b>', Deck: 'D' },
                ord: 0,
                answer: false,
            }),
        ).toBe('abc D');
        expect(
            renderTemplate('{{type:A}}/{{hint:A}}', {
                fields: { A: '<b>hello</b>' },
                ord: 0,
                answer: false,
            }),
        ).toBe('/');
        expect(
            renderTemplate('{{type:A}}/{{hint:A}}', {
                fields: { A: '<b>hello</b>' },
                ord: 0,
                answer: true,
            }),
        ).toBe('hello/<b>hello</b>');
        expect(
            renderTemplate('{{kana:A}} {{kanji:A}} {{furigana:A}}', {
                fields: { A: '猫[ねこ]' },
                ord: 0,
                answer: false,
            }),
        ).toBe('ねこ 猫 <ruby>猫<rt>ねこ</rt></ruby>');
    });
    it('handles nested clozes and hints without hiding inactive text', () => {
        expect(renderCloze('A {{c1::big {{c2::cat}}::animal}}.', 0, false)).toBe('A [animal].');
        expect(renderCloze('A {{c1::big {{c2::cat}}::animal}}.', 1, false)).toBe('A big [...].');
        expect(renderCloze('A {{c1::big {{c2::cat}}::animal}}.', 0, true)).toBe('A big cat.');
    });
    it('extracts answer after hr or strips a repeated question prefix', () => {
        expect(
            renderCard('{{A}}', '{{FrontSide}}<hr id=answer>{{B}}', { A: 'front', B: 'back' }, 0)
                .answer,
        ).toBe('back');
        expect(
            renderCard('{{A}}', '{{FrontSide}} {{B}}', { A: 'front', B: 'back' }, 0).answer,
        ).toBe('back');
    });
    it('normalizes HTML and entities, strips scripts, styles and sounds', () => {
        expect(
            htmlToText(
                '<script>alert(1)</script><style>x{}</style><div>A&nbsp; &amp; &#x732b;</div><p>B</p><br><br><li>C [sound:a.mp3]</li>',
            ),
        ).toBe('A & 猫\n\nB\n\nC');
    });
});
