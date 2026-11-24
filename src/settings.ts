import { App, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type EmailViewerPlugin from "./main";

export interface EmailViewerSettings {
	blockRemoteContent: boolean;
	preferPlainText: boolean;
	htmlTheme: "light" | "adaptive";
	showAllHeaders: boolean;
	/** Folder for notes created from emails. Empty = next to the email file. */
	noteFolder: string;
}

export const DEFAULT_SETTINGS: EmailViewerSettings = {
	blockRemoteContent: true,
	preferPlainText: false,
	htmlTheme: "light",
	showAllHeaders: false,
	noteFolder: "",
};

export class EmailViewerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: EmailViewerPlugin,
	) {
		super(app, plugin);
	}

	/** Declarative settings (Obsidian 1.13+): rendered by Obsidian and included in settings search. */
	getSettingDefinitions(): SettingDefinitionItem<keyof EmailViewerSettings>[] {
		return [
			{
				name: "Block remote content",
				desc: "Don't load images, stylesheets or fonts from the internet. Remote content can be used to track when you open an email. You can still load it per message.",
				aliases: ["images", "tracking", "privacy"],
				control: { type: "toggle", key: "blockRemoteContent", defaultValue: DEFAULT_SETTINGS.blockRemoteContent },
			},
			{
				name: "Prefer plain text",
				desc: "Show the plain-text version of a message by default when both versions exist.",
				control: { type: "toggle", key: "preferPlainText", defaultValue: DEFAULT_SETTINGS.preferPlainText },
			},
			{
				name: "HTML email appearance",
				desc: "Light renders HTML emails on white like a mail client (most reliable). Adaptive uses your theme colours, which can make some emails hard to read.",
				aliases: ["dark mode", "theme"],
				control: {
					type: "dropdown",
					key: "htmlTheme",
					options: { light: "Light (mail client)", adaptive: "Adaptive (follow theme)" },
					defaultValue: DEFAULT_SETTINGS.htmlTheme,
				},
			},
			{
				name: "Show all headers by default",
				desc: "Expand the full list of raw message headers when opening an email.",
				control: { type: "toggle", key: "showAllHeaders", defaultValue: DEFAULT_SETTINGS.showAllHeaders },
			},
			{
				name: "Folder for notes from emails",
				desc: 'Where notes created from emails are saved. Leave empty to save them next to the email file.',
				control: { type: "folder", key: "noteFolder", placeholder: "Next to the email" },
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

	/** Fallback for Obsidian versions before 1.13. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Block remote content")
			.setDesc(
				"Don't load images, stylesheets or fonts from the internet. Remote content can be used to track when you open an email. You can still load it per message.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.blockRemoteContent).onChange(async (v) => {
					this.plugin.settings.blockRemoteContent = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Prefer plain text")
			.setDesc("Show the plain-text version of a message by default when both versions exist.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.preferPlainText).onChange(async (v) => {
					this.plugin.settings.preferPlainText = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("HTML email appearance")
			.setDesc(
				"Light renders HTML emails on white like a mail client (most reliable). Adaptive uses your theme colours, which can make some emails hard to read.",
			)
			.addDropdown((d) =>
				d
					.addOption("light", "Light (mail client)")
					.addOption("adaptive", "Adaptive (follow theme)")
					.setValue(this.plugin.settings.htmlTheme)
					.onChange(async (v) => {
						this.plugin.settings.htmlTheme = v as "light" | "adaptive";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show all headers by default")
			.setDesc("Expand the full list of raw message headers when opening an email.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showAllHeaders).onChange(async (v) => {
					this.plugin.settings.showAllHeaders = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Folder for notes from emails")
			.setDesc('Where notes created from emails are saved. Leave empty to save them next to the email file.')
			.addText((t) =>
				t
					.setPlaceholder("e.g. Inbox/Notes")
					.setValue(this.plugin.settings.noteFolder)
					.onChange(async (v) => {
						this.plugin.settings.noteFolder = v.trim().replace(/^\/+|\/+$/g, "");
						await this.plugin.saveSettings();
					}),
			);
	}
}
