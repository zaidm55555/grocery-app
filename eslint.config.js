// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // backend/ holds separate packages (e.g. the Cloudflare Worker in backend/ai-proxy)
    // with their own tsconfig and tests; they are not part of the app.
    ignores: ["dist/*", "backend/**"],
  },
  {
    // Tests re-require modules after jest.resetModules() to get fresh module state.
    files: ["**/__tests__/**", "jest.setup.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  }
]);
