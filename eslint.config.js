import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

const tsconfigRootDir = import.meta.dirname;

// Backend (Node/Fastify) lint config. The Vue / Tailwind sections that were
// copied over from the frontend config were removed: their plugins are not
// backend dependencies, so ESLint crashed on startup ("Cannot find package
// 'eslint-plugin-vue'") and the backend could not be linted at all.
export default [
    // ── 1. Global ignores ────────────────────────────────────────────────────
    {
        ignores: [
            '.nuxt/**',
            '.output/**',
            'dist/**',
            'coverage/**',
            'node_modules/**',
            'eslint.config.js',
            'nuxt.config.ts',
            // Gitignored build output: the Prisma client and the compiled
            // prisma.config artifacts (the source is prisma.config.ts).
            'generated/**',
            'prisma.config.js',
            'prisma.config.d.ts',
        ],
    },

    // ── 2. TypeScript — .ts files ────────────────────────────────────────────
    ...tsPlugin.configs['flat/recommended'].map((config) => ({
        ...config,
        files: ['**/*.ts'],
    })),
    {
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['*.config.ts', '*.config.js'],
                },
                tsconfigRootDir,
            },
        },
    },

    // ── 3. All files — Prettier + project rules ───────────────────────────────
    {
        files: ['**/*.{js,ts}'],
        plugins: {
            '@typescript-eslint': tsPlugin,
            prettier: prettierPlugin,
        },
        rules: {
            ...prettierConfig.rules,
            'prettier/prettier': 'error',
            'arrow-body-style': 'off',
            'prefer-arrow-callback': 'off',

            // ── General ──────────────────────────────────────────────────────
            'no-console': 'error',
            'no-debugger': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            eqeqeq: ['error', 'always'],
            curly: ['error', 'all'],
            'no-duplicate-imports': 'error',
            'no-useless-return': 'error',
            'no-return-await': 'error',
            'no-throw-literal': 'error',
            'prefer-template': 'error',
            'object-shorthand': ['error', 'always'],
            'no-unused-vars': 'off',
            'no-shadow': 'off',
            'no-use-before-define': 'off',
            'no-redeclare': 'off',
            'no-undef': 'off',
        },
    },

    // ── 4. TypeScript — type-aware rules ─────────────────────────────────────
    {
        files: ['**/*.ts'],
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-shadow': 'error',
            '@typescript-eslint/no-use-before-define': 'error',
            '@typescript-eslint/no-redeclare': 'error',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unsafe-assignment': 'error',
            '@typescript-eslint/no-unsafe-member-access': 'error',
            '@typescript-eslint/no-unsafe-call': 'error',
            '@typescript-eslint/no-unsafe-return': 'error',
            '@typescript-eslint/no-unsafe-argument': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/no-non-null-assertion': 'error',
            '@typescript-eslint/no-unnecessary-condition': 'error',
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/prefer-nullish-coalescing': 'error',
            '@typescript-eslint/prefer-optional-chain': 'error',
            '@typescript-eslint/restrict-template-expressions': 'error',
            '@typescript-eslint/only-throw-error': 'error',
            '@typescript-eslint/consistent-type-imports': 'error',
        },
    },

    // ── 5. Tests — mocks and parsed JSON bodies are untyped by nature ────────
    // test/ and scripts/ each have a tsconfig.json extending the root one, so
    // the project service can type-check them (the root tsconfig only
    // includes src/).
    {
        files: ['test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
        },
    },

    // ── 6. CLI scripts print their progress ──────────────────────────────────
    {
        files: ['scripts/**/*.ts'],
        rules: {
            'no-console': 'off',
        },
    },
];
