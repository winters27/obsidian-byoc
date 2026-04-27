// Strict lint config that mirrors what obsidianmd ReviewBot uses.
// We pass this with --config so it's used instead of the relaxed local config.
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: [
      "*.js",
      "*.cjs",
      "main.js",
      "927.main.js",
      "node_modules/**",
      "dist/**",
      "tests/**",
      "scripts/**",
      "docs/**",
      "esbuild.config.mjs",
      "esbuild.injecthelper.mjs",
      "eslint.config.mjs",
      "eslint.bot.config.mjs",
      "webpack.config.js",
      "vitest.config.ts",
      "biome.json",
      "versions.json",
      "tsconfig.json",
      "package-lock.json",
      "issues*.json",
      "lint-report.json",
      "lint-bot.json",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["package.json"],
    rules: {
      "obsidianmd/no-plugin-as-component": "off",
      "obsidianmd/no-tfile-tfolder-cast": "off",
      "obsidianmd/no-view-references-in-plugin": "off",
      "obsidianmd/prefer-instanceof": "off",
      "obsidianmd/prefer-active-doc": "off",
      "obsidianmd/no-unsupported-api": "off",
      "obsidianmd/object-assign": "off",
      "obsidianmd/prefer-file-manager-trash-file": "off",
      "obsidianmd/regex-lookbehind": "off",
      "obsidianmd/platform": "off",
      "obsidianmd/editor-drop-paste": "off",
      "obsidianmd/detach-leaves": "off",
      "obsidianmd/no-forbidden-elements": "off",
      "obsidianmd/no-static-styles-assignment": "off",
      "obsidianmd/prefer-active-window-timers": "off",
      "obsidianmd/prefer-abstract-input-suggest": "off",
      "obsidianmd/no-sample-code": "off",
      "obsidianmd/sample-names": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/prefer-get-language": "off",
      "obsidianmd/commands/no-command-in-command-id": "off",
      "obsidianmd/commands/no-command-in-command-name": "off",
      "obsidianmd/commands/no-default-hotkeys": "off",
      "obsidianmd/commands/no-plugin-id-in-command-id": "off",
      "obsidianmd/commands/no-plugin-name-in-command-name": "off",
      "obsidianmd/settings-tab/no-manual-html-headings": "off",
      "obsidianmd/settings-tab/no-problematic-settings-headings": "off",
      "obsidianmd/vault/iterate": "off",
      "obsidianmd/ui/sentence-case": "off",
      "obsidianmd/rule-custom-message": "off",
      // ReviewBot doesn't flag these in its actual output — keep the bot
      // config in sync with reality so we don't chase phantom errors.
      "depend/ban-dependencies": ["error", {
        presets: ["native", "microutilities", "preferred"],
        allowed: ["lodash", "emoji-regex", "dotenv", "builtin-modules", "rimraf", "readable-stream"],
      }],
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: { Buffer: "readonly" },
    },
    rules: {
      // Bot enforces these even though obsidianmd recommended turns them off.
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
    },
  },
]);
