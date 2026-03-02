import tsparser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	{
		files: ["src/**/*.ts"],
		plugins: { obsidianmd, "@typescript-eslint": tseslint },
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
		},
		rules: {
			...obsidianmd.configs.recommended,
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
			"@typescript-eslint/await-thenable": "error",
		},
	},
];
