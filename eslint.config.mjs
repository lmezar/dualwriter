import stylistic from '@stylistic/eslint-plugin';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
    {
        ignores: ['out/**', 'dist/**', '**/*.d.ts'],
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        plugins: {
            '@stylistic': stylistic,
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            '@typescript-eslint/naming-convention': [
                'warn',
                {
                    selector: 'import',
                    format: ['camelCase', 'PascalCase'],
                },
            ],
            '@stylistic/semi': 'warn',
            curly: 'warn',
            eqeqeq: 'warn',
            'no-throw-literal': 'warn',
        },
    },
];
