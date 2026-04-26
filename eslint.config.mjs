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
      "eslint.config.mjs",
      "webpack.config.js",
      "vitest.config.ts",
      "src/**/*.worker.ts",
      // JSON files we don't want eslint to parse as JS. package.json is
      // intentionally NOT here — the obsidianmd recommended preset has a
      // dedicated json-language block for it (validate-manifest, depend, etc).
      "biome.json",
      "versions.json",
      "tsconfig.json",
      "package-lock.json",
      "issues*.json",
      "lint-report.json",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    // The recommended preset's package.json block uses tseslint.configs.disableTypeChecked,
    // which only disables @typescript-eslint typed rules — it leaves obsidianmd typed
    // rules (no-plugin-as-component, etc.) trying to resolve type info on a JSON file
    // and crashing the whole lint run. Force them off for package.json.
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
      // Justified runtime/dev dependencies. lodash & emoji-regex are inherited
      // from the upstream remotely-save fork and used pervasively (cloneDeep,
      // debounce, isEqual, chunk, flatten, emojiRegex). dotenv/builtin-modules/
      // rimraf only run in dev tooling and never ship in main.js.
      "depend/ban-dependencies": ["error", {
        presets: ["native", "microutilities", "preferred"],
        allowed: ["lodash", "emoji-regex", "dotenv", "builtin-modules", "rimraf"],
      }],
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        // webpack injects buffer-browserify polyfill globally.
        Buffer: "readonly",
      },
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
