import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	globalIgnores(["node_modules", "build", "main.js", "esbuild.config.mjs", "version-bump.mjs", "test"]),
	...obsidianmd.configs.recommended,
	// The directory's automated review runs more rules than `recommended`; enable them all.
	{
		files: ["**/*.ts"],
		rules: Object.fromEntries(
			Object.keys(obsidianmd.rules)
				.filter((name) => !/^(obsidian-declaration|obsidian-overload|rule-custom-message|sample-names|no-sample-code)/.test(name))
				.map((name) => [`obsidianmd/${name}`, "warn"]),
		),
	},
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*"] },
			},
		},
	},
]);
