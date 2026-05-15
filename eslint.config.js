import parser from "@typescript-eslint/parser";
import plugin from "@typescript-eslint/eslint-plugin";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": plugin,
    },
    rules: {
      ...plugin.configs.recommended.rules,
      ...plugin.configs["strict"].rules,
    },
  },
];
