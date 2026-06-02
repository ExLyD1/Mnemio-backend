/**
 * Demo seed: one verified user + two decks with cards. Idempotent — re-running
 * is a no-op (matches existing user by email).
 *
 * Usage:  npm run seed
 *
 * Credentials printed at the end. Note that no refresh-token cookie is set
 * here — sign in via POST /api/v1/auth/login to start a session.
 */
import argon2 from 'argon2';
import { prisma } from '../src/db/prisma.js';

const DEMO_EMAIL = 'demo@mnemio.local';
const DEMO_PASSWORD = 'demo-password-123';
const DEMO_USERNAME = 'demo';
const DEMO_FULL_NAME = 'Demo User';

const DECKS = [
    {
        title: 'Spanish: Greetings & Basics',
        description: 'Core greetings and small-talk vocabulary.',
        sourceLanguage: 'en',
        targetLanguage: 'es',
        cards: [
            { word: 'Hola', definition: 'Hello', phonetic: '/ˈo.la/' },
            { word: 'Buenos días', definition: 'Good morning', phonetic: null },
            { word: 'Buenas tardes', definition: 'Good afternoon', phonetic: null },
            { word: 'Buenas noches', definition: 'Good evening / night', phonetic: null },
            { word: 'Gracias', definition: 'Thank you', phonetic: '/ˈɡɾa.sjas/' },
            { word: 'Por favor', definition: 'Please', phonetic: null },
            { word: 'Adiós', definition: 'Goodbye', phonetic: null },
            { word: '¿Cómo estás?', definition: 'How are you?', phonetic: null },
        ],
    },
    {
        title: 'Japanese: Hiragana Starter',
        description: 'First ten hiragana characters and their readings.',
        sourceLanguage: 'en',
        targetLanguage: 'ja',
        cards: [
            { word: 'あ', definition: 'a (vowel)', phonetic: '/a/' },
            { word: 'い', definition: 'i (vowel)', phonetic: '/i/' },
            { word: 'う', definition: 'u (vowel)', phonetic: '/ɯ/' },
            { word: 'え', definition: 'e (vowel)', phonetic: '/e/' },
            { word: 'お', definition: 'o (vowel)', phonetic: '/o/' },
            { word: 'か', definition: 'ka', phonetic: '/ka/' },
            { word: 'き', definition: 'ki', phonetic: '/ki/' },
            { word: 'く', definition: 'ku', phonetic: '/kɯ/' },
            { word: 'け', definition: 'ke', phonetic: '/ke/' },
            { word: 'こ', definition: 'ko', phonetic: '/ko/' },
        ],
    },
];

const seed = async () => {
    let user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
    if (!user) {
        const passwordHash = await argon2.hash(DEMO_PASSWORD, {
            type: argon2.argon2id,
            memoryCost: 19_456,
            timeCost: 2,
            parallelism: 1,
        });
        user = await prisma.user.create({
            data: {
                email: DEMO_EMAIL,
                passwordHash,
                fullName: DEMO_FULL_NAME,
                username: DEMO_USERNAME,
                emailVerifiedAt: new Date(),
            },
        });
        console.log(`✔ created user ${user.email}`);
    } else {
        console.log(`• user ${user.email} already exists, skipping creation`);
    }

    for (const spec of DECKS) {
        const existing = await prisma.deck.findFirst({
            where: { authorId: user.id, title: spec.title },
        });
        if (existing) {
            console.log(`• deck "${spec.title}" already exists, skipping`);
            continue;
        }
        const deck = await prisma.deck.create({
            data: {
                authorId: user.id,
                title: spec.title,
                description: spec.description,
                sourceLanguage: spec.sourceLanguage,
                targetLanguage: spec.targetLanguage,
            },
        });
        await prisma.card.createMany({
            data: spec.cards.map((c, i) => ({
                userId: user!.id,
                deckId: deck.id,
                word: c.word,
                definition: c.definition,
                phonetic: c.phonetic,
                position: i,
            })),
        });
        await prisma.deck.update({
            where: { id: deck.id },
            data: { cardCount: spec.cards.length },
        });
        console.log(`✔ created deck "${spec.title}" (${spec.cards.length} cards)`);
    }

    console.log('\n---');
    console.log('Demo credentials:');
    console.log(`  email:    ${DEMO_EMAIL}`);
    console.log(`  password: ${DEMO_PASSWORD}`);
    console.log('---');
};

seed()
    .catch((err) => {
        console.error('Seed failed:', err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
