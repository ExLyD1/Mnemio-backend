// Normalizes free-form language input (locale headers, model output, user
// preferences) down to an ISO 639-1 code so every language field in the DB
// (deck.sourceLanguage/targetLanguage, preference.nativeLanguage/
// learningLanguages) is consistently a 2-letter code the FE's code-keyed
// <select> can match — some AI-generated decks previously stored full names
// ("English") instead of codes, which left the edit screen with nothing
// selected.
//
// Only SUPPORTED languages resolve. Anything else returns null so callers can
// reject it explicitly instead of persisting a made-up code (the model once
// stored "ua" — a country code — for Ukrainian).

const NAME_TO_CODE: Record<string, string> = {
    english: 'en',
    ukrainian: 'uk',
    spanish: 'es',
    french: 'fr',
    german: 'de',
    portuguese: 'pt',
    italian: 'it',
    russian: 'ru',
    polish: 'pl',
    japanese: 'ja',
    korean: 'ko',
    chinese: 'zh',
    mandarin: 'zh',
    arabic: 'ar',
    dutch: 'nl',
    turkish: 'tr',
    vietnamese: 'vi',
    hindi: 'hi',
    swedish: 'sv',
    norwegian: 'no',
    danish: 'da',
    finnish: 'fi',
    greek: 'el',
    czech: 'cs',
    romanian: 'ro',
    hungarian: 'hu',
    hebrew: 'he',
    thai: 'th',
    indonesian: 'id',
};

// The single list of languages a deck/preference may use. Add a language by
// adding its English name to NAME_TO_CODE above.
export const SUPPORTED_LANGS: ReadonlySet<string> = new Set(Object.values(NAME_TO_CODE));

// Common wrong codes the model (or a user) reaches for: country codes that
// aren't language codes, and ISO 639-2 three-letter codes. Every target must
// be in SUPPORTED_LANGS.
const CODE_ALIASES: Record<string, string> = {
    ua: 'uk',
    jp: 'ja',
    cn: 'zh',
    kr: 'ko',
    gr: 'el',
    cz: 'cs',
    dk: 'da',
    se: 'sv',
    eng: 'en',
    ukr: 'uk',
    spa: 'es',
    fra: 'fr',
    fre: 'fr',
    deu: 'de',
    ger: 'de',
    ita: 'it',
    por: 'pt',
    pol: 'pl',
    rus: 'ru',
    jpn: 'ja',
    kor: 'ko',
    zho: 'zh',
    chi: 'zh',
    nld: 'nl',
    dut: 'nl',
    tur: 'tr',
};

// Reverse of NAME_TO_CODE, built once — capitalized English display names
// for the codes we recognize. Used to give the model an unambiguous language
// name instead of a bare ISO code, which is easy to under-weight as an
// instruction (see buildChatSystemPrompt).
const CODE_TO_NAME: Record<string, string> = Object.fromEntries(
    Object.entries(NAME_TO_CODE).map(([name, code]) => [
        code,
        name.charAt(0).toUpperCase() + name.slice(1),
    ]),
);

// Language names as users actually type them: English, Ukrainian and the
// language's own name ("німецька", "Deutsch", "español", "日本語"). Built from
// the runtime's ICU data; if that's unavailable we keep the English map only.
const buildNameIndex = (): Record<string, string> => {
    const index: Record<string, string> = { ...NAME_TO_CODE };
    try {
        for (const code of SUPPORTED_LANGS) {
            for (const displayLocale of ['en', 'uk', code]) {
                const name = new Intl.DisplayNames([displayLocale], { type: 'language' }).of(code);
                if (name && name !== code) {
                    index[name.toLowerCase()] ??= code;
                }
            }
        }
    } catch {
        // No ICU language data — English names still resolve.
    }
    return index;
};

const NAME_INDEX = buildNameIndex();

// Human-readable display name for an ISO 639-1 code (e.g. "uk" → "Ukrainian").
// Falls back to the bare code itself when unrecognized, so callers always get
// a usable string.
export const langDisplayName = (code: string): string => CODE_TO_NAME[code] ?? code;

export const isSupportedLang = (code: string): boolean => SUPPORTED_LANGS.has(code);

// Accepts codes like "en", "uk-UA", "ua", "eng", and names like "English",
// "Ukrainian", "українська", "Deutsch"; returns a supported 2-letter ISO 639-1
// code, or null when it can't be resolved to one.
export const normalizeLang = (raw: string | null | undefined): string | null => {
    if (!raw) {
        return null;
    }
    const lowered = raw.trim().toLowerCase();
    if (lowered.length === 0) {
        return null;
    }

    const byName = NAME_INDEX[lowered];
    if (byName) {
        return byName;
    }

    // "uk-UA" / "en_US" / "zh-Hans" → take the language subtag.
    const base = lowered.split(/[-_]/)[0] ?? lowered;
    if (SUPPORTED_LANGS.has(base)) {
        return base;
    }
    return CODE_ALIASES[base] ?? null;
};
