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
    },
  },
]);
