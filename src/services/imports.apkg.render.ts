/** Anki's template subset. This is an import-to-text renderer, never a browser HTML renderer. */
const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ensp: ' ',
    emsp: ' ',
    thinsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    copy: '©',
    reg: '®',
    trade: '™',
    middot: '·',
    bull: '•',
    times: '×',
    divide: '÷',
    auml: 'ä',
    ouml: 'ö',
    uuml: 'ü',
    Auml: 'Ä',
    Ouml: 'Ö',
    Uuml: 'Ü',
    szlig: 'ß',
    eacute: 'é',
    Eacute: 'É',
    agrave: 'à',
    egrave: 'è',
    acirc: 'â',
    ecirc: 'ê',
    ocirc: 'ô',
    ccedil: 'ç',
};
export const decodeEntities = (s: string): string =>
    s.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (match: string, entity: string) => {
        if (!entity.startsWith('#')) {
            return ENTITIES[entity] ?? match;
        }
        const n =
            entity[1]?.toLowerCase() === 'x'
                ? Number.parseInt(entity.slice(2), 16)
                : Number.parseInt(entity.slice(1), 10);
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
            ? String.fromCodePoint(n)
            : '�';
    });
export const htmlToText = (html: string): string =>
    decodeEntities(
        html
            .replace(/<!--[^]*?-->/g, '')
            .replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
            .replace(/\[sound:[^\]]*\]/gi, '')
            .replace(/<\/?(?:br|div|p|li|tr)\b[^>]*>[\t ]*(?:\r?\n)?/gi, '\n')
            .replace(/<[^>]*>/g, ''),
    )
        .replace(/\r\n?/g, '\n')
        .replace(/[\t\f\v \u00a0]+/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

type Token =
    | { text: string }
    | { field: string }
    | { section: string; inverted: boolean; children: Token[] };
const tokenize = (template: string): Token[] => {
    const root: Token[] = [],
        stack: { name: string; tokens: Token[] }[] = [{ name: '', tokens: root }];
    const pattern = /{{([^]*?)}}/g;
    let cursor = 0;
    for (const match of template.matchAll(pattern)) {
        const top = stack.at(-1);
        if (!top) {
            break;
        }
        if (match.index > cursor) {
            top.tokens.push({ text: template.slice(cursor, match.index) });
        }
        const tag = (match[1] ?? '').trim();
        if (tag[0] === '#' || tag[0] === '^') {
            const section = tag.slice(1).trim(),
                children: Token[] = [];
            top.tokens.push({ section, inverted: tag[0] === '^', children });
            if (stack.length < 100) {
                stack.push({ name: section, tokens: children });
            }
        } else if (tag[0] === '/') {
            if (stack.length > 1 && top.name === tag.slice(1).trim()) {
                stack.pop();
            }
        } else if (!tag.startsWith('!')) {
            top.tokens.push({ field: tag });
        }
        cursor = match.index + match[0].length;
    }
    stack.at(-1)?.tokens.push({ text: template.slice(cursor) });
    return root;
};

/** Nested cloze parser, including hints containing HTML and nested deletions. */
export const renderCloze = (input: string, ordinal: number, answer: boolean): string => {
    const render = (text: string, depth: number): string => {
        if (depth > 50) {
            return text;
        }
        let result = '',
            cursor = 0;
        const startPattern = /{{c(\d+)::/gi;
        for (;;) {
            startPattern.lastIndex = cursor;
            const start = startPattern.exec(text);
            if (!start) {
                return result + text.slice(cursor);
            }
            result += text.slice(cursor, start.index);
            let pos = start.index + start[0].length,
                nesting = 1,
                hint = -1;
            const bodyStart = pos;
            for (; pos < text.length - 1; pos++) {
                const pair = text.slice(pos, pos + 2);
                if (pair === '{{') {
                    nesting++;
                    pos++;
                } else if (pair === '}}') {
                    nesting--;
                    if (!nesting) {
                        break;
                    }
                    pos++;
                } else if (pair === '::' && nesting === 1 && hint < 0) {
                    hint = pos;
                    pos++;
                }
            }
            if (nesting) {
                return result + text.slice(start.index);
            }
            const body = text.slice(bodyStart, hint >= 0 ? hint : pos);
            const active = Number(start[1]) === ordinal + 1;
            result +=
                active && !answer
                    ? `[${hint >= 0 ? text.slice(hint + 2, pos) : '...'}]`
                    : render(body, depth + 1);
            cursor = pos + 2;
        }
    };
    return render(input, 0);
};
const furigana = (input: string, mode: string): string =>
    input.replace(/([^\s\[\]<>]+)\[([^\]]+)\]/g, (_m: string, kanji: string, kana: string) => {
        if (mode === 'kana') {
            return kana;
        }
        if (mode === 'kanji') {
            return kanji;
        }
        return `<ruby>${kanji}<rt>${kana}</rt></ruby>`;
    });
export type RenderContext = {
    fields: Record<string, string>;
    ord: number;
    answer: boolean;
    frontSide?: string;
};
export const renderTemplate = (template: string, ctx: RenderContext): string => {
    const fieldValue = (expression: string): string => {
        const parts = expression.split(':');
        const name = (parts.pop() ?? '').trim();
        let value = name === 'FrontSide' ? (ctx.frontSide ?? '') : (ctx.fields[name] ?? '');
        for (const filter of parts.reverse()) {
            switch (filter.trim().toLowerCase()) {
                case 'text':
                    value = htmlToText(value);
                    break;
                case 'type':
                    value = ctx.answer ? htmlToText(value) : '';
                    break;
                case 'cloze':
                    value = renderCloze(value, ctx.ord, ctx.answer);
                    break;
                case 'hint':
                    value = ctx.answer ? value : '';
                    break;
                case 'furigana':
                case 'kana':
                case 'kanji':
                    value = furigana(value, filter);
                    break;
            }
        }
        return value;
    };
    const renderTokens = (tokens: Token[]): string =>
        tokens
            .map((token): string => {
                if ('text' in token) {
                    return token.text;
                }
                if ('field' in token) {
                    return fieldValue(token.field);
                }
                const value = ctx.fields[token.section] ?? '';
                const present = htmlToText(value).length > 0 || /<img\b|\[sound:/i.test(value);
                return present !== token.inverted ? renderTokens(token.children) : '';
            })
            .join('');
    return renderTokens(tokenize(template));
};
export const renderCard = (
    qfmt: string,
    afmt: string,
    fields: Record<string, string>,
    ord: number,
) => {
    const questionHtml = renderTemplate(qfmt, { fields, ord, answer: false });
    const answerHtml = renderTemplate(afmt, { fields, ord, answer: true, frontSide: questionHtml });
    const hr = /<hr\b(?=[^>]*\bid\s*=\s*(?:["']answer["']|answer(?=[\s/>])))[^>]*>/i.exec(
        answerHtml,
    );
    let answer = answerHtml;
    if (hr) {
        answer = answer.slice(hr.index + hr[0].length);
    } else if (questionHtml && answer.startsWith(questionHtml)) {
        answer = answer.slice(questionHtml.length);
    }
    return {
        questionHtml,
        answerHtml,
        answerContentHtml: answer,
        question: htmlToText(questionHtml),
        answer: htmlToText(answer),
    };
};
const attribute = (html: string, name: string): string => {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(html);
    return decodeEntities(m?.[1] ?? m?.[2] ?? m?.[3] ?? '');
};
export const imageReferences = (html: string): { name: string; alt: string }[] =>
    Array.from(html.matchAll(/<img\b[^>]*>/gi), (m) => ({
        name: attribute(m[0], 'src'),
        alt: htmlToText(attribute(m[0], 'alt')),
    }));
export const soundReferences = (html: string): string[] =>
    Array.from(html.matchAll(/\[sound:([^\]]+)\]/gi), (m) => decodeEntities(m[1] ?? ''));
export const capText = (text: string, max: number, marker = ''): string => {
    if (text.length <= max) {
        return text;
    }
    let cut = text.slice(0, max - marker.length);
    if (/[\uD800-\uDBFF]$/.test(cut)) {
        cut = cut.slice(0, -1);
    }
    return cut.trimEnd() + marker;
};
