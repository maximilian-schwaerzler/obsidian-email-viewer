import { FileView, Menu, Notice, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type EmailViewerPlugin from "./main";
import { prepareHtml } from "./html";
import {
	EmailAddress,
	EmailAttachment,
	ParsedEmail,
	SUPPORTED_EXTENSIONS,
	parseEml,
	parseEmailFile,
	splitMbox,
	summarizeEml,
} from "./parse";

export const VIEW_TYPE_EMAIL = "email-viewer";

export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export function formatAddress(a: EmailAddress): string {
	return a.name && a.address ? `${a.name} <${a.address}>` : a.name || a.address;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentIcon(a: EmailAttachment): string {
	const m = a.mimeType;
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("audio/")) return "file-audio";
	if (m.startsWith("video/")) return "file-video";
	if (m === "application/pdf") return "file-text";
	if (m === "message/rfc822" || m === "application/vnd.ms-outlook") return "mail";
	if (m === "text/calendar") return "calendar";
	if (/zip|compressed|tar|rar|7z/.test(m)) return "file-archive";
	return "paperclip";
}

const URL_RE = /\b(?:https?:\/\/|mailto:|www\.)[^\s<>"']+/gi;

/** Append text to `el`, turning URLs into clickable links (no innerHTML involved). */
function appendLinkified(el: HTMLElement, text: string) {
	let last = 0;
	for (const m of text.matchAll(URL_RE)) {
		let url = m[0].replace(/[.,;:!?)\]}>]+$/, "");
		const start = m.index!;
		if (start > last) el.appendText(text.slice(last, start));
		const href = url.toLowerCase().startsWith("www.") ? `https://${url}` : url;
		el.createEl("a", { text: url, href, cls: "external-link", attr: { target: "_blank", rel: "noopener" } });
		last = start + url.length;
	}
	if (last < text.length) el.appendText(text.slice(last));
}

export class EmailView extends FileView {
	allowNoFile = false;

	/** The message currently shown (for mbox: the selected one). */
	current: ParsedEmail | null = null;

	private blobUrls: string[] = [];
	private loadToken = 0;
	private cleanupFns: (() => void)[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: EmailViewerPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_EMAIL;
	}

	getIcon(): string {
		return "mail";
	}

	canAcceptExtension(extension: string): boolean {
		return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
	}

	async onOpen(): Promise<void> {
		this.addAction("file-plus", "Create note from email", () => {
			if (this.current && this.file) void this.plugin.createNoteFromEmail(this.current, this.file);
		});
	}

	async onLoadFile(file: TFile): Promise<void> {
		await this.reload(file);
	}

	async onUnloadFile(): Promise<void> {
		this.loadToken++;
		this.disposeMessage();
		this.current = null;
		this.contentEl.empty();
	}

	async onClose(): Promise<void> {
		this.disposeMessage();
	}

	/** Re-read the file from disk and render it again. */
	async reload(file: TFile | null = this.file): Promise<void> {
		if (!file) return;
		const token = ++this.loadToken;
		const root = this.contentEl;
		root.empty();
		root.addClass("email-viewer");
		root.createDiv({ cls: "email-viewer-status", text: "Loading email…" });

		try {
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			if (token !== this.loadToken) return;

			if (file.extension.toLowerCase() === "mbox") {
				await this.renderMbox(root, bytes, token);
			} else {
				const email = await parseEmailFile(bytes, file.extension);
				if (token !== this.loadToken) return;
				root.empty();
				this.renderMessage(root.createDiv({ cls: "email-viewer-message" }), email);
			}
		} catch (e) {
			if (token !== this.loadToken) return;
			console.error("Email Viewer: failed to open", file.path, e);
			root.empty();
			const err = root.createDiv({ cls: "email-viewer-error" });
			setIcon(err.createSpan(), "alert-triangle");
			err.createEl("h3", { text: "Could not display this email" });
			err.createEl("p", { text: e instanceof Error ? e.message : String(e) });
		}
	}

	// -----------------------------------------------------------------------
	// mbox
	// -----------------------------------------------------------------------

	private async renderMbox(root: HTMLElement, bytes: Uint8Array, token: number) {
		const raw = splitMbox(bytes);
		root.empty();
		if (raw.length === 0) {
			root.createDiv({ cls: "email-viewer-status", text: "This mailbox is empty." });
			return;
		}
		if (raw.length === 1) {
			this.renderMessage(root.createDiv({ cls: "email-viewer-message" }), await parseEml(raw[0]));
			return;
		}

		const box = root.createDiv({ cls: "email-viewer-mbox" });
		const bar = box.createDiv({ cls: "email-viewer-mbox-bar" });
		bar.createSpan({ cls: "email-viewer-mbox-count", text: `${raw.length} messages` });
		const search = bar.createEl("input", {
			type: "search",
			placeholder: "Filter by subject or sender…",
			cls: "email-viewer-mbox-search",
		});
		const list = box.createDiv({ cls: "email-viewer-mbox-list", attr: { tabindex: "0" } });
		const messageEl = root.createDiv({ cls: "email-viewer-message" });

		const rows: { el: HTMLElement; haystack: string }[] = [];
		let selected = -1;

		const select = async (i: number) => {
			if (i < 0 || i >= raw.length || i === selected) return;
			rows[selected]?.el.removeClass("is-selected");
			selected = i;
			rows[i].el.addClass("is-selected");
			rows[i].el.scrollIntoView({ block: "nearest" });
			messageEl.empty();
			messageEl.createDiv({ cls: "email-viewer-status", text: "Loading…" });
			try {
				const email = await parseEml(raw[i]);
				if (token !== this.loadToken || selected !== i) return;
				messageEl.empty();
				this.renderMessage(messageEl, email);
			} catch (e) {
				messageEl.empty();
				messageEl.createDiv({ cls: "email-viewer-error", text: `Could not parse message: ${String(e)}` });
			}
		};

		raw.forEach((_, i) => {
			const el = list.createDiv({ cls: "email-viewer-mbox-row" });
			el.createDiv({ cls: "email-viewer-mbox-subject", text: `Message ${i + 1}` });
			el.createDiv({ cls: "email-viewer-mbox-meta" });
			el.addEventListener("click", () => void select(i));
			rows.push({ el, haystack: "" });
		});

		list.addEventListener("keydown", (ev) => {
			const visible = rows.map((r, i) => (r.el.isShown() ? i : -1)).filter((i) => i >= 0);
			const pos = visible.indexOf(selected);
			if (ev.key === "ArrowDown" && pos < visible.length - 1) void select(visible[pos + 1]);
			else if (ev.key === "ArrowUp" && pos > 0) void select(visible[pos - 1]);
			else return;
			ev.preventDefault();
		});

		search.addEventListener("input", () => {
			const q = search.value.trim().toLowerCase();
			for (const r of rows) r.el.toggle(!q || r.haystack.includes(q));
		});

		void select(0);

		// Fill in summaries progressively so large mailboxes stay responsive.
		for (let i = 0; i < raw.length; i++) {
			if (token !== this.loadToken) return;
			try {
				const s = await summarizeEml(raw[i]);
				const row = rows[i];
				const subject = s.subject || "(no subject)";
				const from = s.from.map((a) => a.name || a.address).join(", ");
				row.el.querySelector(".email-viewer-mbox-subject")!.setText(subject);
				const meta = row.el.querySelector(".email-viewer-mbox-meta") as HTMLElement;
				meta.empty();
				meta.createSpan({ cls: "email-viewer-mbox-from", text: from });
				if (s.date) meta.createSpan({ cls: "email-viewer-mbox-date", text: window.moment(s.date).format("lll") });
				row.haystack = `${subject} ${from} ${s.from.map((a) => a.address).join(" ")}`.toLowerCase();
			} catch {
				/* keep placeholder */
			}
			if (i % 50 === 49) await new Promise((r) => window.setTimeout(r, 0));
		}
	}

	// -----------------------------------------------------------------------
	// Single message
	// -----------------------------------------------------------------------

	private disposeMessage() {
		this.cleanupFns.forEach((fn) => fn());
		this.cleanupFns = [];
		this.blobUrls.forEach((u) => URL.revokeObjectURL(u));
		this.blobUrls = [];
	}

	private blobUrl(att: EmailAttachment): string {
		const url = URL.createObjectURL(new Blob([toArrayBuffer(att.content)], { type: att.mimeType }));
		this.blobUrls.push(url);
		return url;
	}

	private renderMessage(container: HTMLElement, email: ParsedEmail) {
		this.disposeMessage();
		this.current = email;
		const settings = this.plugin.settings;

		const hasHtml = !!email.html?.trim();
		const hasText = !!email.text?.trim();
		let mode: "html" | "text" = hasHtml && !(settings.preferPlainText && hasText) ? "html" : "text";
		let allowRemote = !settings.blockRemoteContent;

		// --- Header -----------------------------------------------------------
		const header = container.createDiv({ cls: "email-viewer-header" });
		header.createEl("h1", { cls: "email-viewer-subject", text: email.subject || "(no subject)" });

		const meta = header.createDiv({ cls: "email-viewer-meta" });
		const addRow = (label: string, addrs: EmailAddress[]) => {
			if (!addrs.length) return;
			const row = meta.createDiv({ cls: "email-viewer-meta-row" });
			row.createSpan({ cls: "email-viewer-meta-label", text: label });
			const val = row.createSpan({ cls: "email-viewer-meta-value" });
			addrs.forEach((a) => this.renderAddress(val, a));
		};
		addRow("From", email.from);
		addRow("To", email.to);
		addRow("Cc", email.cc);
		addRow("Bcc", email.bcc);
		if (
			email.replyTo.length &&
			email.replyTo.map((a) => a.address).join() !== email.from.map((a) => a.address).join()
		) {
			addRow("Reply-To", email.replyTo);
		}
		if (email.date || email.dateRaw) {
			const row = meta.createDiv({ cls: "email-viewer-meta-row" });
			row.createSpan({ cls: "email-viewer-meta-label", text: "Date" });
			const d = row.createSpan({
				cls: "email-viewer-meta-value",
				text: email.date ? window.moment(email.date).format("LLLL") : email.dateRaw,
			});
			if (email.date) setTooltip(d, email.date.toISOString());
		}

		// --- Toolbar ----------------------------------------------------------
		const toolbar = header.createDiv({ cls: "email-viewer-toolbar" });
		const bodyEl = container.createDiv({ cls: "email-viewer-body" });
		const attachEl = container.createDiv({ cls: "email-viewer-attachments" });
		const headersEl = header.createDiv({ cls: "email-viewer-raw-headers" });
		const remoteBanner = createDiv({ cls: "email-viewer-remote-banner" });
		container.insertBefore(remoteBanner, bodyEl);

		if (hasHtml && hasText) {
			const seg = toolbar.createDiv({ cls: "email-viewer-segmented" });
			const htmlBtn = seg.createEl("button", { text: "HTML" });
			const textBtn = seg.createEl("button", { text: "Plain text" });
			const sync = () => {
				htmlBtn.toggleClass("is-active", mode === "html");
				textBtn.toggleClass("is-active", mode === "text");
			};
			htmlBtn.onclick = () => {
				mode = "html";
				sync();
				renderBody();
			};
			textBtn.onclick = () => {
				mode = "text";
				sync();
				renderBody();
			};
			sync();
		}

		const headersBtn = toolbar.createEl("button", { cls: "clickable-icon email-viewer-tool" });
		setIcon(headersBtn.createSpan(), "list");
		headersBtn.createSpan({ text: "Headers" });
		let headersShown = settings.showAllHeaders;
		const renderHeaders = () => {
			headersEl.empty();
			headersEl.toggle(headersShown);
			headersBtn.toggleClass("is-active", headersShown);
			if (!headersShown) return;
			const table = headersEl.createEl("table");
			for (const h of email.headers) {
				const tr = table.createEl("tr");
				tr.createEl("th", { text: h.key });
				tr.createEl("td", { text: h.value });
			}
			if (!email.headers.length) headersEl.createDiv({ text: "No headers available." });
		};
		headersBtn.onclick = () => {
			headersShown = !headersShown;
			renderHeaders();
		};
		renderHeaders();

		const noteBtn = toolbar.createEl("button", { cls: "clickable-icon email-viewer-tool" });
		setIcon(noteBtn.createSpan(), "file-plus");
		noteBtn.createSpan({ text: "Create note" });
		noteBtn.onclick = () => {
			if (this.file) void this.plugin.createNoteFromEmail(email, this.file);
		};

		// --- Body ---------------------------------------------------------------
		let usedCids = new Set<string>();
		const renderBody = () => {
			bodyEl.empty();
			remoteBanner.empty();
			remoteBanner.hide();
			usedCids = new Set();

			if (mode === "html" && hasHtml) {
				const prepared = prepareHtml(email.html!, {
					allowRemote,
					theme: settings.htmlTheme,
					attachments: email.attachments,
					resolveCid: (a) => this.blobUrl(a),
				});
				usedCids = prepared.usedContentIds;
				if (prepared.hasRemoteContent && !allowRemote) {
					remoteBanner.show();
					setIcon(remoteBanner.createSpan(), "shield");
					remoteBanner.createSpan({ text: "Remote images and styles were blocked to protect your privacy." });
					const btn = remoteBanner.createEl("button", { text: "Load remote content" });
					btn.onclick = () => {
						allowRemote = true;
						renderBody();
					};
				}
				this.renderIframe(bodyEl, prepared.srcdoc, settings.htmlTheme);
			} else if (hasText) {
				const pre = bodyEl.createDiv({ cls: "email-viewer-text" });
				appendLinkified(pre, email.text!);
			} else {
				bodyEl.createDiv({ cls: "email-viewer-status", text: "This message has no text content." });
			}
			renderAttachments();
		};

		// --- Attachments ------------------------------------------------------
		const renderAttachments = () => {
			attachEl.empty();
			const visible = email.attachments.filter((a) => !(a.contentId && usedCids.has(a.contentId)));
			attachEl.toggle(visible.length > 0);
			if (!visible.length) return;
			const head = attachEl.createDiv({ cls: "email-viewer-attachments-head" });
			setIcon(head.createSpan(), "paperclip");
			head.createSpan({ text: `${visible.length} attachment${visible.length === 1 ? "" : "s"}` });
			if (visible.length > 1) {
				const all = head.createEl("button", { text: "Save all to vault" });
				all.onclick = async () => {
					for (const a of visible) await this.saveAttachment(a);
				};
			}
			const grid = attachEl.createDiv({ cls: "email-viewer-attachment-list" });
			for (const a of visible) {
				const chip = grid.createDiv({ cls: "email-viewer-attachment" });
				setIcon(chip.createSpan({ cls: "email-viewer-attachment-icon" }), attachmentIcon(a));
				const info = chip.createDiv({ cls: "email-viewer-attachment-info" });
				info.createDiv({ cls: "email-viewer-attachment-name", text: a.filename });
				info.createDiv({ cls: "email-viewer-attachment-size", text: `${formatBytes(a.content.length)} · ${a.mimeType}` });
				setTooltip(chip, a.filename);
				chip.addEventListener("click", (ev) => this.attachmentMenu(a).showAtMouseEvent(ev));
				chip.addEventListener("contextmenu", (ev) => {
					ev.preventDefault();
					this.attachmentMenu(a).showAtMouseEvent(ev);
				});
			}
		};

		renderBody();
	}

	private renderAddress(parent: HTMLElement, a: EmailAddress) {
		const chip = parent.createSpan({ cls: "email-viewer-address" });
		if (a.name) chip.createSpan({ cls: "email-viewer-address-name", text: a.name });
		if (a.address) chip.createSpan({ cls: "email-viewer-address-email", text: a.name ? `<${a.address}>` : a.address });
		chip.addEventListener("click", (ev) => {
			const menu = new Menu();
			menu.addItem((i) =>
				i
					.setTitle("Copy address")
					.setIcon("copy")
					.onClick(() => void navigator.clipboard.writeText(a.address)),
			);
			menu.addItem((i) =>
				i
					.setTitle("Copy name and address")
					.setIcon("copy")
					.onClick(() => void navigator.clipboard.writeText(formatAddress(a))),
			);
			if (a.address.includes("@")) {
				menu.addItem((i) =>
					i
						.setTitle("Write email")
						.setIcon("send")
						.onClick(() => window.open(`mailto:${a.address}`)),
				);
			}
			menu.showAtMouseEvent(ev);
		});
	}

	private renderIframe(parent: HTMLElement, srcdoc: string, theme: "light" | "adaptive") {
		const iframe = parent.createEl("iframe", { cls: "email-viewer-iframe" });
		iframe.toggleClass("is-light", theme === "light");
		// No allow-scripts: nothing inside the email can run. allow-same-origin lets
		// us measure the content height and intercept link clicks from outside.
		iframe.setAttribute("sandbox", "allow-same-origin");
		iframe.setAttribute("referrerpolicy", "no-referrer");
		iframe.srcdoc = srcdoc;

		iframe.addEventListener("load", () => {
			const doc = iframe.contentDocument;
			if (!doc) return;
			let adjustments = 0;
			let lastHeight = 0;
			const fit = () => {
				// Some emails use height:100% layouts that grow with the frame;
				// stop chasing after a while to avoid an endless resize loop.
				if (adjustments > 40) return;
				// Measure the content itself; scrollHeight never drops below the frame's viewport.
				const h = Math.ceil(
					Math.max(doc.documentElement.getBoundingClientRect().height, doc.body?.scrollHeight ?? 0),
				);
				if (Math.abs(h - lastHeight) < 2) return;
				adjustments++;
				lastHeight = h;
				// Include the frame's own border so no inner scrollbar appears.
				const chrome = iframe.offsetHeight - iframe.clientHeight;
				iframe.style.height = `${h + Math.max(0, chrome)}px`;
			};
			fit();
			const ro = new ResizeObserver(() => fit());
			ro.observe(doc.documentElement);
			if (doc.body) ro.observe(doc.body);
			this.cleanupFns.push(() => ro.disconnect());
			// Images load after "load" only if lazy; re-fit once everything settles.
			window.setTimeout(fit, 300);

			doc.addEventListener("click", (ev) => {
				const target = ev.target as Element | null;
				const a = target?.closest?.("a[href]");
				if (!a) return;
				ev.preventDefault();
				const href = a.getAttribute("href") ?? "";
				if (href.startsWith("#")) {
					const id = decodeURIComponent(href.slice(1));
					(doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView();
					return;
				}
				if (/^(https?:|mailto:|tel:|obsidian:)/i.test(href)) window.open(href, "_blank");
			});
		});
	}

	private attachmentMenu(a: EmailAttachment): Menu {
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Open")
				.setIcon("external-link")
				.onClick(async () => {
					const f = await this.saveAttachment(a);
					if (f) await this.app.workspace.getLeaf("tab").openFile(f);
				}),
		);
		menu.addItem((i) =>
			i
				.setTitle("Save to vault")
				.setIcon("download")
				.onClick(() => void this.saveAttachment(a)),
		);
		menu.addItem((i) =>
			i
				.setTitle("Download…")
				.setIcon("hard-drive-download")
				.onClick(() => {
					const link = createEl("a", { href: this.blobUrl(a), attr: { download: a.filename } });
					link.click();
				}),
		);
		return menu;
	}

	/** Save an attachment using Obsidian's configured attachment location. */
	private async saveAttachment(a: EmailAttachment): Promise<TFile | null> {
		try {
			const safeName = a.filename.replace(/[\\/:*?"<>|]/g, "_") || "attachment";
			const path = await this.app.fileManager.getAvailablePathForAttachment(safeName, this.file?.path);
			const file = await this.app.vault.createBinary(path, toArrayBuffer(a.content));
			new Notice(`Saved ${file.path}`);
			return file;
		} catch (e) {
			new Notice(`Could not save attachment: ${String(e)}`);
			return null;
		}
	}
}
