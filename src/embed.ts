import { App, Component, Keymap, TFile, setIcon } from "obsidian";
import { EmailAddress, SUPPORTED_EXTENSIONS, parseEmailFile, splitMbox } from "./parse";

/**
 * Card shown for `![[message.eml]]` embeds instead of Obsidian's generic file box.
 *
 * Embeds are rendered through Obsidian's (undocumented) embed registry, the same
 * mechanism the core PDF/image embeds use. Everything here is guarded so the plugin
 * degrades to the default file embed if that API changes.
 */

interface EmbedContext {
	app: App;
	containerEl: HTMLElement;
	linktext?: string;
	sourcePath?: string;
}

interface EmbedRegistry {
	registerExtensions(exts: string[], creator: (ctx: EmbedContext, file: TFile, subpath: string) => Component): void;
	unregisterExtensions(exts: string[]): void;
}

function embedRegistry(app: App): EmbedRegistry | null {
	const reg = (app as unknown as { embedRegistry?: Partial<EmbedRegistry> }).embedRegistry;
	return typeof reg?.registerExtensions === "function" && typeof reg.unregisterExtensions === "function"
		? (reg as EmbedRegistry)
		: null;
}

/** Register the email card embed. Returns a function that undoes the registration. */
export function registerEmailEmbeds(app: App): () => void {
	const reg = embedRegistry(app);
	if (!reg) return () => {};
	const exts = [...SUPPORTED_EXTENSIONS];
	try {
		reg.registerExtensions(exts, (ctx, file) => new EmailEmbed(ctx, file));
	} catch (e) {
		console.warn("Email Viewer: could not register email embeds", e);
		return () => {};
	}
	return () => reg.unregisterExtensions(exts);
}

const SNIPPET_LENGTH = 200;

function displayName(a: EmailAddress): string {
	return a.name || a.address;
}

function snippetOf(text: string | undefined, html: string | undefined): string {
	let s = text?.trim() ? text : "";
	if (!s && html) {
		const doc = new DOMParser().parseFromString(html, "text/html");
		doc.querySelectorAll("script, style, head").forEach((el) => el.remove());
		s = doc.body.textContent ?? "";
	}
	s = s.replace(/\s+/g, " ").trim();
	return s.length > SNIPPET_LENGTH ? s.slice(0, SNIPPET_LENGTH).trimEnd() + "…" : s;
}

class EmailEmbed extends Component {
	private loadToken = 0;

	constructor(
		private ctx: EmbedContext,
		private file: TFile,
	) {
		super();
	}

	onload(): void {
		const el = this.ctx.containerEl;
		el.addClass("email-viewer-embed-container");

		const open = (evt: MouseEvent) => {
			// Leave right clicks and text selection alone.
			if (evt.button > 1 || window.getSelection()?.toString()) return;
			evt.preventDefault();
			evt.stopPropagation();
			const newLeaf = evt.button === 1 || Keymap.isModEvent(evt);
			void this.ctx.app.workspace.openLinkText(this.file.path, this.ctx.sourcePath ?? "", newLeaf);
		};
		this.registerDomEvent(el, "click", open);
		this.registerDomEvent(el, "auxclick", open);

		this.registerEvent(
			this.ctx.app.vault.on("modify", (f) => {
				if (f === this.file) void this.loadFile();
			}),
		);
	}

	/** Called by Obsidian after the embed is created. */
	async loadFile(): Promise<void> {
		const token = ++this.loadToken;
		const file = this.file;
		const root = this.ctx.containerEl;

		try {
			const bytes = new Uint8Array(await this.ctx.app.vault.readBinary(file));
			if (token !== this.loadToken) return;

			if (file.extension.toLowerCase() === "mbox") {
				const count = splitMbox(bytes).length;
				this.renderCard(root, {
					icon: "inbox",
					title: file.basename,
					meta: ["Mailbox", `${count} ${count === 1 ? "message" : "messages"}`],
				});
				return;
			}

			const email = await parseEmailFile(bytes, file.extension);
			if (token !== this.loadToken) return;

			const html = email.html?.toLowerCase() ?? "";
			const attachments = email.attachments.filter(
				(a) => !(a.contentId && html.includes(`cid:${a.contentId.toLowerCase()}`)),
			).length;

			const meta: string[] = [];
			if (email.from.length) meta.push(email.from.map(displayName).join(", "));
			if (email.date) meta.push(window.moment(email.date).format("lll"));
			else if (email.dateRaw) meta.push(email.dateRaw);

			this.renderCard(root, {
				icon: "mail",
				title: email.subject || "(no subject)",
				meta,
				attachments,
				snippet: snippetOf(email.text, email.html),
				tooltip: file.path,
			});
		} catch (e) {
			if (token !== this.loadToken) return;
			console.error("Email Viewer: failed to render embed", file.path, e);
			this.renderCard(root, { icon: "alert-triangle", title: file.name, meta: ["Could not read this email"] });
		}
	}

	private renderCard(
		root: HTMLElement,
		card: { icon: string; title: string; meta: string[]; attachments?: number; snippet?: string; tooltip?: string },
	) {
		root.empty();
		const el = root.createDiv({ cls: "email-viewer-embed" });
		if (card.tooltip) el.setAttr("aria-label", card.tooltip);
		setIcon(el.createDiv({ cls: "email-viewer-embed-icon" }), card.icon);

		const body = el.createDiv({ cls: "email-viewer-embed-body" });
		body.createDiv({ cls: "email-viewer-embed-subject", text: card.title });

		const meta = body.createDiv({ cls: "email-viewer-embed-meta" });
		card.meta.forEach((m, i) => {
			if (i) meta.createSpan({ cls: "email-viewer-embed-sep", text: "·" });
			meta.createSpan({ text: m });
		});
		if (card.attachments) {
			const att = meta.createSpan({ cls: "email-viewer-embed-attachments" });
			setIcon(att.createSpan(), "paperclip");
			att.createSpan({ text: String(card.attachments) });
		}

		if (card.snippet) body.createDiv({ cls: "email-viewer-embed-snippet", text: card.snippet });
	}
}
