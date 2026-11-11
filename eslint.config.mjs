import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// Function components and hooks only.
const noClassComponents = {
  selector:
    "ClassDeclaration[superClass.name=/^(Component|PureComponent)$/], ClassDeclaration[superClass.property.name=/^(Component|PureComponent)$/]",
  message: "Use a function component and hooks instead of a class component.",
};

// Time is injected (docs/testing.md): product code reads the clock through kernel/clock.
const noDirectClock = {
  selector:
    "NewExpression[callee.name='Date'][arguments.length=0], CallExpression[callee.object.name='Date'][callee.property.name='now']",
  message:
    "Read the time through the injected clock (src/kernel/clock.ts), not Date.now() or new Date().",
};

export default defineConfig([
  globalIgnores(["**/dist/**", "**/target/**", "**/src-tauri/gen/**", "**/coverage/**"]),
  js.configs.recommended,
  ...tseslint.configs.strict,
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-restricted-syntax": ["error", noClassComponents, noDirectClock],
    },
  },
  // The clock module itself, tests and build tooling may read real time.
  {
    files: ["**/kernel/clock.ts", "**/*.test.{ts,tsx}", "**/*.config.{ts,mts,mjs}", "scripts/**"],
    rules: { "no-restricted-syntax": ["error", noClassComponents] },
  },
  {
    files: ["**/*.config.{ts,mts,mjs}", "scripts/**"],
    languageOptions: { globals: { ...globals.node } },
  },
  // Dev scripts print their results.
  { files: ["scripts/**"], rules: { "no-console": "off" } },
  prettier,
]);
