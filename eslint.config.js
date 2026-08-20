import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Baseline shared by every package.
 *
 *  Only the web app had a lint script, and `pnpm -r lint` skips a package that
 *  does not define one — silently. So the server, where the security-critical
 *  code lives, was never linted at all.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      // Prisma writes this; it is not ours to lint.
      "apps/server/src/generated/**",
      "apps/server/projects/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The codebase deliberately narrows `unknown` from JSON and socket
      // payloads by hand, which these two would flag on every such site.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    files: ["apps/server/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["packages/shared/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Build tooling sits outside the app tsconfigs, so type-aware linting has
    // no program for it. Its own typecheck covers it.
    files: ["**/*.config.{ts,js}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Tests reach for expressions that are pointless in production code.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
