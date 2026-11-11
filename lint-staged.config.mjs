/**
 * Runs on staged files before each commit (see .husky/pre-commit).
 * Type-checking and tests need the whole project, so they run on pre-push and in CI instead.
 * @type {import("lint-staged").Configuration}
 */
const config = {
  "*.{ts,tsx,js,mjs}": ["eslint --fix --max-warnings=0 --no-warn-ignored", "prettier --write"],
  "*.{json,md,css,yml,yaml,html}": "prettier --write",
  "*.rs": () => "cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml",
};

export default config;
