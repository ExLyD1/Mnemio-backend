// Normalizes free-form language input (locale headers, model output, user
// preferences) down to an ISO 639-1 code so every language field in the DB
// (deck.sourceLanguage/targetLanguage, preference.nativeLanguage/
// learningLanguages) is consistently a 2-letter code the FE's code-keyed
// <select> can match — some AI-generated decks previously stored full names
// ("English") instead of codes, which left the edit screen with nothing
// selected.

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

// Accepts codes like "en", "uk-UA", "English", "Ukrainian"; returns a bare
// 2-letter ISO 639-1 code, or null when it can't be resolved.
export const normalizeLang = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    // "uk-UA" / "en_US" → take the language subtag.
    const base = trimmed.split(/[-_]/)[0]!.toLowerCase();
    if (/^[a-z]{2}$/.test(base)) return base;

    const byName = NAME_TO_CODE[trimmed.toLowerCase()];
    if (byName) return byName;

    return null;
};
