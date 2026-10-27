import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';
import { AppError, UnprocessableError } from '../shared/errors.js';
import {
    ApkgZip,
    apkgTooLarge,
    decodeZstd,
    invalidApkg,
    normalizeAnkiCollation,
    protobuf,
    protoBytes,
    protoNumber,
    protoText,
    ZIP_LIMITS,
} from './imports.apkg.binary.js';
import {
    capText,
    htmlToText,
    imageReferences,
    renderCard,
    soundReferences,
} from './imports.apkg.render.js';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Row = Record<string, NodeSqlite.SQLOutputValue>;
export type AnkiNotetype = {
    id: number;
    name: string;
    kind: 'normal' | 'cloze';
    fields: string[];
    templates: { name: string; qfmt: string; afmt: string }[];
    css: string;
};
type AnkiDeck = { id: number; name: string; description: string; config: Json };
export type ApkgCard = {
    word: string;
    definition: string;
    tags: string[];
    type: 'basic' | 'cloze' | 'image';
    reading: string | null;
    phonetic: string | null;
    example: string | null;
    exampleTranslation: string | null;
    partOfSpeech: string | null;
    imageName: string | null;
    audioName: string | null;
    sourceData: JsonObject;
};
export type ApkgDeck = {
    title: string;
    description: string;
    cards: ApkgCard[];
    sourceData: JsonObject;
};
export type ParsedApkg = {
    decks: ApkgDeck[];
    cardsSkipped: number;
    warnings: string[];
    media: Map<string, () => Buffer>;
};
export const APKG_CARD_LIMIT = 20_000;
const unsupported = (message: string): never => {
    throw new UnprocessableError('IMPORT_APKG_UNSUPPORTED', message);
};
const object = (v: Json | undefined): JsonObject =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
const array = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const text = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const number = (v: Json | undefined, fallback = 0): number =>
    typeof v === 'number' ? v : fallback;
const json = (v: string): Json => JSON.parse(v) as Json;
const str = (r: Row, key: string): string => {
    const v = r[key];
    if (typeof v !== 'string') {
        return invalidApkg(`Invalid SQLite text: ${key}`);
    }
    return v;
};
const num = (r: Row, key: string): number => {
    const v = r[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
        return invalidApkg(`Invalid SQLite integer: ${key}`);
    }
    return v;
};
const blob = (r: Row, key: string): Buffer => {
    const v = r[key];
    if (!(v instanceof Uint8Array)) {
        return invalidApkg(`Invalid SQLite blob: ${key}`);
    }
    return Buffer.from(v);
};

/** Suppress only node:sqlite's initialization warning, including under --throw-deprecation.
 * Synchronous require keeps the temporary warning hook scoped to this module load.
 */
const openSqlite = (filename: string): NodeSqlite.DatabaseSync => {
    const original = process.emitWarning;
    try {
        process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
            if (
                typeof warning === 'string' &&
                /SQLite is an experimental feature/i.test(warning) &&
                args[0] === 'ExperimentalWarning'
            ) {
                return;
            }
            Reflect.apply(original, process, [warning, ...args]);
        }) as typeof process.emitWarning;
        const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite;
        return new sqlite.DatabaseSync(filename, {
            readOnly: true,
            enableDoubleQuotedStringLiterals: false,
            allowExtension: false,
        });
    } finally {
        process.emitWarning = original;
    }
};

const decodeDeckConfig = (row: Row): JsonObject => {
    const raw = blob(row, 'config');
    const fields = protobuf(raw);
    // Names and numbers from anki/deck_config.proto. Preserve unknown options losslessly too.
    const names: Record<number, string> = {
        1: 'learn_steps',
        2: 'relearn_steps',
        3: 'fsrs_params_4',
        4: 'easy_days_percentages',
        5: 'fsrs_params_5',
        6: 'fsrs_params_6',
        9: 'new_per_day',
        10: 'reviews_per_day',
        11: 'initial_ease',
        12: 'easy_multiplier',
        13: 'hard_multiplier',
        14: 'lapse_multiplier',
        15: 'interval_multiplier',
        16: 'maximum_review_interval',
        17: 'minimum_lapse_interval',
        18: 'graduating_interval_good',
        19: 'graduating_interval_easy',
        20: 'new_card_insert_order',
        21: 'leech_action',
        22: 'leech_threshold',
        23: 'disable_autoplay',
        24: 'cap_answer_time_to_secs',
        25: 'show_timer',
        26: 'skip_question_when_replaying_answer',
        27: 'bury_new',
        28: 'bury_reviews',
        29: 'bury_interday_learning',
        30: 'new_mix',
        31: 'interday_learning_mix',
        32: 'new_card_sort_order',
        33: 'review_order',
        34: 'new_card_gather_priority',
        35: 'new_per_day_minimum',
        36: 'question_action',
        37: 'desired_retention',
        38: 'stop_timer_on_answer',
        40: 'historical_retention',
        41: 'seconds_to_show_question',
        42: 'seconds_to_show_answer',
        43: 'answer_action',
        44: 'wait_for_audio',
        45: 'param_search',
        46: 'ignore_revlogs_before_date',
        255: 'other',
    };
    const result: JsonObject = {
        id: num(row, 'id'),
        name: str(row, 'name'),
        protobuf: raw.toString('base64'),
    };
    for (const f of fields) {
        const key = names[f.number] ?? `field_${f.number}`;
        if (typeof f.value === 'number') {
            result[key] = f.value;
        } else if (f.wire === 5) {
            result[key] = f.value.readFloatLE();
        } else if (f.number <= 6 && f.wire === 2) {
            const values: number[] = [];
            if (f.value.length % 4) {
                invalidApkg('Invalid packed deck options');
            }
            for (let i = 0; i < f.value.length; i += 4) {
                values.push(f.value.readFloatLE(i));
            }
            result[key] = values;
        } else {
            result[key] = f.value.toString(f.number === 45 || f.number === 46 ? 'utf8' : 'base64');
        }
    }
    return result;
};
const readMetadata = (db: NodeSqlite.DatabaseSync, schema: number) => {
    const notetypes = new Map<number, AnkiNotetype>(),
        decks = new Map<number, AnkiDeck>();
    if (schema === 11) {
        const col = db.prepare('SELECT models, decks, dconf FROM col').get();
        if (!col) {
            return invalidApkg('Missing collection metadata');
        }
        const configs = object(json(str(col, 'dconf')));
        for (const v of Object.values(object(json(str(col, 'models'))))) {
            const m = object(v),
                id = number(m.id);
            const fields = array(m.flds)
                .map(object)
                .sort((a, b) => number(a.ord) - number(b.ord))
                .map((f) => text(f.name));
            const templates = array(m.tmpls)
                .map(object)
                .sort((a, b) => number(a.ord) - number(b.ord))
                .map((t) => ({ name: text(t.name), qfmt: text(t.qfmt), afmt: text(t.afmt) }));
            notetypes.set(id, {
                id,
                name: text(m.name),
                kind: number(m.type) === 1 ? 'cloze' : 'normal',
                fields,
                templates,
                css: text(m.css),
            });
        }
        for (const v of Object.values(object(json(str(col, 'decks'))))) {
            const d = object(v),
                id = number(d.id);
            decks.set(id, {
                id,
                name: text(d.name),
                description: text(d.desc),
                config: configs[String(number(d.conf, 1))] ?? null,
            });
        }
    } else {
        const configs = new Map(
            db
                .prepare('SELECT id,name,config FROM deck_config')
                .all()
                .map((row) => [num(row, 'id'), decodeDeckConfig(row)]),
        );
        // Include config to avoid Anki's covering name index (custom unicase collation).
        const fields = db
            .prepare('SELECT * FROM fields NOT INDEXED')
            .all()
            .sort((a, b) => num(a, 'ord') - num(b, 'ord'));
        const templates = db
            .prepare('SELECT * FROM templates NOT INDEXED')
            .all()
            .sort((a, b) => num(a, 'ord') - num(b, 'ord'));
        for (const row of db.prepare('SELECT id,name,config FROM notetypes').all()) {
            const id = num(row, 'id'),
                config = protobuf(blob(row, 'config'));
            notetypes.set(id, {
                id,
                name: str(row, 'name'),
                kind: protoNumber(config, 1) === 1 ? 'cloze' : 'normal',
                css: protoText(config, 3),
                fields: fields.filter((f) => num(f, 'ntid') === id).map((f) => str(f, 'name')),
                templates: templates
                    .filter((t) => num(t, 'ntid') === id)
                    .map((t) => {
                        const cfg = protobuf(blob(t, 'config'));
                        return {
                            name: str(t, 'name'),
                            qfmt: protoText(cfg, 1),
                            afmt: protoText(cfg, 2),
                        };
                    }),
            });
        }
        for (const row of db.prepare('SELECT id,name,kind FROM decks').all()) {
            const id = num(row, 'id'),
                container = protobuf(blob(row, 'kind'));
            const normal = protobuf(protoBytes(container, 1));
            decks.set(id, {
                id,
                name: str(row, 'name').replaceAll('\u001f', '::'),
                description: protoText(normal, 4),
                config: configs.get(protoNumber(normal, 1, 1)) ?? null,
            });
        }
    }
    return { notetypes, decks };
};

const mediaMap = (zip: ApkgZip): Map<string, () => Buffer> => {
    const result = new Map<string, () => Buffer>();
    if (!zip.has('media')) {
        return result;
    }
    const raw = decodeZstd(zip.read('media'), 20_000_000);
    const names: [string, string][] = [];
    if (raw.toString('utf8', 0, 1) === '{') {
        for (const [key, value] of Object.entries(object(json(raw.toString('utf8'))))) {
            names.push([text(value), key]);
        }
    } else {
        let index = 0;
        for (const field of protobuf(raw)) {
            if (field.number !== 1 || !Buffer.isBuffer(field.value)) {
                continue;
            }
            const entry = protobuf(field.value);
            names.push([protoText(entry, 1), String(protoNumber(entry, 255, index))]);
            index++;
        }
    }
    if (names.length > ZIP_LIMITS.entries) {
        apkgTooLarge('Too many media entries');
    }
    let decodedTotal = 0;
    for (const [name, key] of names) {
        if (!name || !zip.has(key)) {
            continue;
        }
        result.set(name, () => {
            const data = decodeZstd(zip.read(key));
            decodedTotal += data.length;
            if (decodedTotal > ZIP_LIMITS.totalBytes) {
                apkgTooLarge('Decoded media exceeds extraction limits');
            }
            return data;
        });
    }
    return result;
};
const heuristics = (fields: Record<string, string>) => {
    const out: Pick<
        ApkgCard,
        'reading' | 'phonetic' | 'example' | 'exampleTranslation' | 'partOfSpeech'
    > = {
        reading: null,
        phonetic: null,
        example: null,
        exampleTranslation: null,
        partOfSpeech: null,
    };
    for (const [name, html] of Object.entries(fields)) {
        const value = htmlToText(html);
        if (!value) {
            continue;
        }
        const n = name.toLowerCase().trim();
        if (/^(reading|furigana|kana)$/.test(n)) {
            out.reading ??= capText(value, 120);
        } else if (/^(ipa|pronunciation|phonetic|transcription)$/.test(n)) {
            out.phonetic ??= capText(value, 120);
        } else if (/^(example translation|sentence translation|translation)$/.test(n)) {
            out.exampleTranslation ??= capText(value, 500);
        } else if (/^(example|sentence)$/.test(n)) {
            out.example ??= capText(value, 500);
        } else if (/^(part of speech|pos)$/.test(n)) {
            out.partOfSpeech ??= capText(value, 40);
        }
    }
    return out;
};

export const parseApkg = async (bytes: Buffer): Promise<ParsedApkg> => {
    const zip = new ApkgZip(bytes);
    const file = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find((name) =>
        zip.has(name),
    );
    if (!file) {
        return invalidApkg('No collection in package');
    }
    const collection = decodeZstd(zip.read(file));
    if (collection.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
        return invalidApkg('Collection is not SQLite');
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'mnemio-apkg-'));
    let db: NodeSqlite.DatabaseSync | undefined;
    try {
        const filename = path.join(dir, 'collection.sqlite');
        normalizeAnkiCollation(collection);
        await writeFile(filename, collection);
        db = openSqlite(filename);
        db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
        const col = db.prepare('SELECT ver FROM col').get();
        if (!col) {
            return invalidApkg('Missing collection');
        }
        const schema = num(col, 'ver');
        if (schema !== 11 && schema !== 18) {
            return unsupported(`Unsupported Anki schema: ${schema}`);
        }
        const { notetypes, decks } = readMetadata(db, schema);
        // The backwards-compatibility collection is real SQLite, but only contains this message.
        if (
            file === 'collection.anki2' &&
            db
                .prepare(
                    "SELECT 1 FROM notes WHERE flds LIKE '%Please update to the latest Anki version%' LIMIT 1",
                )
                .get()
        ) {
            return unsupported('Package contains only the Anki update stub');
        }
        const media = mediaMap(zip),
            warnings: string[] = [],
            imported = new Map<number, ApkgDeck>();
        const totalRow = db.prepare('SELECT count(*) AS total FROM cards').get();
        const total = totalRow ? num(totalRow, 'total') : 0;
        const revlog = db.prepare(
            'SELECT id,ease,ivl,lastIvl,factor,time,type FROM revlog WHERE cid=? ORDER BY id DESC LIMIT 50',
        );
        const query = db.prepare(
            'SELECT c.*,n.guid,n.mid,n.tags,n.flds FROM cards c JOIN notes n ON n.id=c.nid ORDER BY c.nid,c.ord,c.id',
        );
        let count = 0,
            examined = 0;
        for (const row of query.iterate()) {
            if (count >= APKG_CARD_LIMIT) {
                warnings.push('card_limit_reached: truncated at 20000 cards');
                break;
            }
            examined++;
            const id = num(row, 'id'),
                did = num(row, 'odid') || num(row, 'did'),
                ord = num(row, 'ord');
            const nt = notetypes.get(num(row, 'mid')),
                deck = decks.get(did);
            const template = nt?.templates[nt.kind === 'cloze' ? 0 : ord];
            if (!nt || !deck || !template) {
                warnings.push(`card_skipped: ${id} missing deck or template`);
                continue;
            }
            const values = str(row, 'flds').split('\u001f');
            const fields = Object.fromEntries(nt.fields.map((name, i) => [name, values[i] ?? '']));
            const tags = str(row, 'tags').trim().split(/\s+/).filter(Boolean);
            const rendered = renderCard(
                template.qfmt,
                template.afmt,
                {
                    ...fields,
                    Tags: tags.join(' '),
                    Deck: deck.name,
                    Subdeck: deck.name.split('::').at(-1) ?? '',
                    Card: template.name,
                    Type: nt.name,
                },
                ord,
            );
            const qImage = imageReferences(rendered.questionHtml).find((img) =>
                media.has(img.name),
            );
            const aImage = imageReferences(rendered.answerContentHtml).find((img) =>
                media.has(img.name),
            );
            let word = rendered.question,
                definition = rendered.answer;
            let type: ApkgCard['type'] = nt.kind === 'cloze' ? 'cloze' : 'basic';
            if (!word && qImage) {
                word = qImage.alt || '🖼️';
                type = 'image';
            }
            if (!definition && aImage) {
                definition = '🖼️';
            }
            if (!word || !definition) {
                warnings.push(`card_skipped: ${id} empty question or answer`);
                continue;
            }
            const imageName = qImage?.name ?? aImage?.name ?? null;
            const audioName =
                soundReferences(rendered.questionHtml + rendered.answerHtml).find((name) =>
                    media.has(name),
                ) ?? null;
            const scheduling: JsonObject = {};
            for (const key of [
                'type',
                'queue',
                'due',
                'ivl',
                'factor',
                'reps',
                'lapses',
                'left',
                'odue',
                'odid',
                'flags',
            ]) {
                scheduling[key] = num(row, key);
            }
            const history = revlog
                .all(id)
                .map((r) =>
                    Object.fromEntries(
                        Object.entries(r).map(([key, value]) => [
                            key,
                            typeof value === 'number' ? value : null,
                        ]),
                    ),
                )
                .reverse();
            const card: ApkgCard = {
                word: capText(word, 500, '…'),
                definition: capText(definition, 2000),
                tags: [...new Set(tags.map((tag) => capText(tag, 40)))].slice(0, 20),
                type,
                ...heuristics(fields),
                imageName,
                audioName,
                sourceData: {
                    anki: {
                        noteId: num(row, 'nid'),
                        guid: str(row, 'guid'),
                        cardId: id,
                        ord,
                        templateName: template.name,
                        notetype: { id: nt.id, name: nt.name, kind: nt.kind },
                        fields,
                        tags,
                        deckName: deck.name,
                        scheduling,
                        revlog: history,
                        questionHtml: rendered.questionHtml,
                        answerHtml: rendered.answerHtml,
                    },
                },
            };
            let target = imported.get(deck.id);
            if (!target) {
                target = {
                    title: capText(deck.name.replaceAll('::', ' › '), 120),
                    description: capText(htmlToText(deck.description), 500),
                    cards: [],
                    sourceData: {
                        anki: {
                            deckId: deck.id,
                            name: deck.name,
                            description: deck.description,
                            config: deck.config,
                            notetypes: [],
                        },
                        mediaFiles: [...media.keys()],
                        package: { file },
                    },
                };
                imported.set(deck.id, target);
            }
            target.cards.push(card);
            count++;
        }
        // Include each used notetype once, with original HTML fields/templates/CSS intact.
        for (const target of imported.values()) {
            const used = new Set(
                target.cards.map((card) =>
                    number(object(object(card.sourceData.anki).notetype).id),
                ),
            );
            object(target.sourceData.anki).notetypes = [...notetypes.values()]
                .filter((nt) => used.has(nt.id))
                .map((nt) => ({ ...nt }));
        }
        if (!count) {
            throw new UnprocessableError('IMPORT_APKG_EMPTY', 'No importable cards in package');
        }
        if (examined < total && count < APKG_CARD_LIMIT) {
            warnings.push('cards_skipped: missing notes');
        }
        return { decks: [...imported.values()], cardsSkipped: total - count, warnings, media };
    } catch (err) {
        if (err instanceof AppError) {
            throw err;
        }
        return invalidApkg('Corrupt Anki collection');
    } finally {
        try {
            db?.close();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
};
