import { MarkdownView, Notice, Plugin, TFile, normalizePath, htmlToMarkdown } from "obsidian";
import { DEFAULT_SETTINGS, EmailViewerSettingTab, EmailViewerSettings } from "./settings";
import { EmailView, VIEW_TYPE_EMAIL, formatAddress } from "./view";
import { ParsedEmail, SUPPORTED_EXTENSIONS, parseEmailFile } from "./parse";
import { registerEmailEmbeds } from "./embed";

export default class EmailViewerPlugin extends Plugin {
	settings: EmailViewerSettings = DEFAULT_SETTINGS;
	private unregisterEmbeds: (() => void) | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_EMAIL, (leaf) => new EmailView(leaf, this));
		this.registerExtensions([...SUPPORTED_EXTENSIONS], VIEW_TYPE_EMAIL);
		this.addSettingTab(new EmailViewerSettingTab(this.app, this));
		this.updateEmbeds();
		this.register(() => this.unregisterEmbeds?.());

		// Re-render open emails when the file changes on disk (e.g. synced or replaced).
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				for (const view of this.emailViews()) if (view.file === file) void view.reload(file);
			}),
		);

		this.addCommand({
			id: "create-note-from-email",
			name: "Create note from current email",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(EmailView);
				if (!view?.current || !view.file) return false;
				if (!checking) void this.createNoteFromEmail(view.current, view.file);
				return true;
			},
		});

		this.addCommand({
			id: "reload-email",
			name: "Reload current email",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(EmailView);
				if (!view) return false;
				if (!checking) void view.reload();
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || !this.isEmailFile(file) || file.extension.toLowerCase() === "mbox") return;
				menu.addItem((item) =>
					item
						.setTitle("Create note from email")
						.setIcon("file-plus")
						.onClick(async () => {
							try {
								const bytes = new Uint8Array(await this.app.vault.readBinary(file));
								await this.createNoteFromEmail(await parseEmailFile(bytes, file.extension), file);
							} catch (e) {
								new Notice(`Could not read email: ${String(e)}`);
							}
						}),
				);
			}),
		);
	}

	isEmailFile(file: TFile): boolean {
		return (SUPPORTED_EXTENSIONS as readonly string[]).includes(file.extension.toLowerCase());
	}

	emailViews(): EmailView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_EMAIL)
			.map((l) => l.view)
			.filter((v): v is EmailView => v instanceof EmailView);
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<EmailViewerSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
	}

	/** Register or unregister the embed cards to match the setting. Returns whether anything changed. */
	private updateEmbeds(): boolean {
		if (this.settings.embedCards && !this.unregisterEmbeds) {
			this.unregisterEmbeds = registerEmailEmbeds(this.app);
		} else if (!this.settings.embedCards && this.unregisterEmbeds) {
			this.unregisterEmbeds();
			this.unregisterEmbeds = null;
		} else {
			return false;
		}
		return true;
	}

	/** Re-render open notes that embed an email, so a changed embed setting shows up immediately. */
	private async refreshEmailEmbeds() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file) continue;
			const embeds = this.app.metadataCache.getFileCache(view.file)?.embeds ?? [];
			const embedsEmail = embeds.some((e) => {
				const target = this.app.metadataCache.getFirstLinkpathDest(e.link.split("#")[0], view.file!.path);
				return target ? this.isEmailFile(target) : false;
			});
			if (!embedsEmail) continue;

			// Both the reading view and the (possibly hidden) editor cache rendered embeds;
			// reopening the note is the only public way to rebuild them. Mode and scroll position are kept.
			const state = leaf.getViewState();
			const eState = view.getEphemeralState();
			await leaf.setViewState({ type: "empty" });
			await leaf.setViewState(state, eState);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.updateEmbeds()) await this.refreshEmailEmbeds();
		for (const view of this.emailViews()) void view.reload();
	}

	/** Create a Markdown note with the email's metadata as properties and its body as Markdown. */
	async createNoteFromEmail(email: ParsedEmail, source: TFile): Promise<void> {
		try {
			const folder = this.settings.noteFolder || source.parent?.path || "";
			if (folder && !this.app.vault.getAbstractFileByPath(normalizePath(folder))) {
				await this.app.vault.createFolder(normalizePath(folder));
			}

			const base =
				(email.subject || source.basename)
					.replace(/[\\/:*?"<>|#^[\]]/g, "")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 100) || "Email";
			let path = "";
			for (let n = 0; ; n++) {
				path = normalizePath(`${folder ? folder + "/" : ""}${base}${n ? ` ${n}` : ""}.md`);
				if (!this.app.vault.getAbstractFileByPath(path)) break;
			}

			const body = this.emailBodyToMarkdown(email);
			const file = await this.app.vault.create(path, `# ${email.subject || "(no subject)"}\n\n${body}\n`);

			const linktext = this.app.metadataCache.fileToLinktext(source, path, false);
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm.subject = email.subject;
				if (email.from.length) fm.from = email.from.map(formatAddress).join(", ");
				if (email.to.length) fm.to = email.to.map(formatAddress);
				if (email.cc.length) fm.cc = email.cc.map(formatAddress);
				if (email.date) fm.date = window.moment(email.date).format("YYYY-MM-DDTHH:mm:ss");
				// Inline images referenced from the HTML body aren't real attachments.
				const html = email.html?.toLowerCase() ?? "";
				const files = email.attachments.filter((a) => !(a.contentId && html.includes(`cid:${a.contentId.toLowerCase()}`)));
				if (files.length) fm.attachments = files.map((a) => a.filename);
				fm.source = `[[${linktext}]]`;
			});

			await this.app.workspace.getLeaf("tab").openFile(file);
		} catch (e) {
			console.error(e);
			new Notice(`Could not create note: ${String(e)}`);
		}
	}

	private emailBodyToMarkdown(email: ParsedEmail): string {
		if (email.html?.trim() && !(this.settings.preferPlainText && email.text?.trim())) {
			const doc = new DOMParser().parseFromString(email.html, "text/html");
			doc.querySelectorAll("script, style, head, title, meta, link").forEach((el) => el.remove());
			doc.querySelectorAll("img").forEach((img) => {
				const src = img.getAttribute("src") ?? "";
				// cid: images can't be referenced from a note; remote ones would track you.
				if (/^cid:/i.test(src) || (this.settings.blockRemoteContent && /^(https?:)?\/\//i.test(src))) img.remove();
			});
			doc.querySelectorAll("a[href]").forEach((a) => {
				if (!/^(https?:|mailto:|tel:|obsidian:|#)/i.test(a.getAttribute("href")!.trim())) a.removeAttribute("href");
			});
			return htmlToMarkdown(doc.body).trim();
		}
		return (email.text ?? "").trim();
	}
}
