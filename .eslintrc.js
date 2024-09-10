module.exports = {
  env: {
    node: true,
  },
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:ava/recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  ignorePatterns: ["dist/**/*"],
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
  },
};
