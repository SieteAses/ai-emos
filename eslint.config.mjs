// Configuración plana de ESLint (v9). Lintea el JS/ESM del repo para cazar bugs
// reales (variables sin usar, no-undef, código inalcanzable…). El formato lo lleva
// Prettier; aquí no hay reglas de estilo, así que no chocan.
import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['**/node_modules/**', 'vscode-extension/bundled/**', '**/*.vsix'],
  },
  js.configs.recommended,
  {
    // núcleo, sdk y scripts: ESM de Node
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // extensión de VS Code: CommonJS de Node
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      // los args sin usar son parte del contrato de los adaptadores (detect/parse/
      // listSessions reciben `opts` aunque no siempre lo usen) y de helpers locales.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
]
