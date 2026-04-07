import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import tailwindPlugin from 'eslint-plugin-tailwindcss';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

const tsconfigRootDir = import.meta.dirname;

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

    // ── 3. Vue — recommended flat config ─────────────────────────────────────
    ...pluginVue.configs['flat/recommended'],

    // ── 4. Vue — TypeScript inside .vue files ────────────────────────────────
    {
        files: ['**/*.vue'],
        plugins: { '@typescript-eslint': tsPlugin },
        languageOptions: {
            parser: vueParser,
            parserOptions: {
                parser: tsParser,
                ecmaVersion: 'latest',
                sourceType: 'module',
                projectService: true,
                tsconfigRootDir,
                extraFileExtensions: ['.vue'],
            },
        },
    },

    // ── 5. Tailwind ──────────────────────────────────────────────────────────
    ...tailwindPlugin.configs['flat/recommended'],

    // ── 6. All files — Prettier + project rules ───────────────────────────────
    {
        files: ['**/*.{js,ts,vue}'],
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

    // ── 8. TypeScript + Vue — type-aware rules ───────────────────────────────
    {
        files: ['**/*.{ts,vue}'],
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

            // ── Vue ──────────────────────────────────────────────────────────
            'vue/component-api-style': ['error', ['script-setup', 'composition']],
            'vue/no-mutating-props': 'error',
            'vue/no-use-v-if-with-v-for': 'error',
            'vue/no-setup-props-reactivity-loss': 'error',
            'vue/no-ref-as-operand': 'error',
            'vue/no-unused-vars': 'error',

            // ── Tailwind ─────────────────────────────────────────────────────
            // 'tailwindcss/classnames-order': 'error',
            // 'tailwindcss/enforces-shorthand': 'error',
            // 'tailwindcss/no-contradicting-classname': 'error',
            // 'tailwindcss/no-unnecessary-arbitrary-value': 'error',
            // 'tailwindcss/no-custom-classname': 'error',
        },
    },
];
