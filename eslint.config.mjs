import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: [
      "main.js",
      "927.main.js",
      "node_modules/**",
      "dist/**",
      "tests/**",
      "scripts/**",
      "docs/**",
      "src/langs/**",
      "esbuild.config.mjs",
      "esbuild.injecthelper.mjs",
      "webpack.config.js",
      "vitest.config.ts",
      "src/**/*.worker.ts",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // Disable the auto-convert-to-unknown fixer so eslint --fix doesn't
      // cascade type errors. We still flag `any` and replace it manually.
      "@typescript-eslint/no-explicit-any": [
        "error",
        { fixToUnknown: false },
      ],
      // BYOC is a brand acronym ("Bring Your Own Cloud") and provider names
      // (OneDrive, pCloud, WebDAV, etc.) are proper nouns. The sentence-case
      // rule fights both. We'll handle individual cases inline.
      "obsidianmd/ui/sentence-case": "off",
      // Don't flag unused catch params or args/vars prefixed with _.
      // Catch param names are often required for legacy compat or readability.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "none",
          caughtErrors: "none",
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
]);
