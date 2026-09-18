import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Catch floating promises — the most common source of silent failures
      "@typescript-eslint/no-floating-promises": "error",
      // Discourage unchecked type assertions
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "as" },
      ],
      // Prefer nullish coalescing over || for nullable checks
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      // Prefer optional chaining
      "@typescript-eslint/prefer-optional-chain": "warn",
      // No explicit any
      "@typescript-eslint/no-explicit-any": "warn",
      // Unused vars (backup for tsc)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Consistent void vs return in async functions.
      // checksVoidReturn.arguments is disabled: passing async functions to
      // addEventListener is standard web practice and not a real bug.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false } },
      ],
      // Empty catches hide failures; require a reason comment or logging.
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["playwright.config.ts", "tests/browser/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.playwright.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "as" },
      ],
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false } },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/**"],
  },
];
