/**
 * Turns untrusted email HTML into a document that is safe to show in a
 * sandboxed iframe: scripts and active content are stripped, `cid:` references
 * are resolved to the inline attachments, and remote content is blocked via CSP
 * unless the user allows it.
 */
import type { EmailAttachment } from "./parse";

export interface PreparedHtml {
	/** Full HTML document for the iframe's srcdoc. */
	srcdoc: string;
	/** True if the message references remote resources (images, CSS, fonts). */
	hasRemoteContent: boolean;
	/** Content-IDs that were resolved to inline images (hide them from the attachment list). */
	usedContentIds: Set<string>;
}

export interface PrepareOptions {
	allowRemote: boolean;
	/** "light" = paper-white like a mail client, "adaptive" = follow Obsidian's theme colours. */
	theme: "light" | "adaptive";
	/** Resolve a cid to a URL (blob:) for an inline attachment. */
	resolveCid: (att: EmailAttachment) => string;
	attachments: EmailAttachment[];
}

const REMOVE_SELECTOR = [
	"script",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"applet",
	"base",
	"meta[http-equiv]",
	"link:not([rel~='stylesheet' i])",
	"portal",
].join(",");

const URL_ATTRS = ["href", "src", "action", "formaction", "background", "poster", "xlink:href", "srcset"];
const REMOTE_RE = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_RE = /url\(\s*['"]?\s*(https?:)?\/\//i;

export function prepareHtml(html: string, opts: PrepareOptions): PreparedHtml {
	const doc = new DOMParser().parseFromString(html, "text/html");
	doc.querySelectorAll(REMOVE_SELECTOR).forEach((el) => el.remove());

	const cidMap = new Map<string, EmailAttachment>();
	for (const a of opts.attachments) if (a.contentId) cidMap.set(a.contentId.toLowerCase(), a);
	const usedContentIds = new Set<string>();
	let hasRemoteContent = false;

	const resolve = (value: string): string | null => {
		const m = /^\s*cid:(.+)$/i.exec(value);
		if (!m) return null;
		const id = decodeURIComponent(m[1].trim()).replace(/^<|>$/g, "").toLowerCase();
		const att = cidMap.get(id);
		if (!att) return null;
		usedContentIds.add(att.contentId!);
		return opts.resolveCid(att);
	};

	for (const el of Array.from(doc.querySelectorAll("*"))) {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			const value = attr.value;
			if (name.startsWith("on")) {
				el.removeAttribute(attr.name);
				continue;
			}
			if (URL_ATTRS.includes(name)) {
				if (/^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
					el.removeAttribute(attr.name);
					continue;
				}
				const cid = resolve(value);
				if (cid) {
					el.setAttribute(attr.name, cid);
					continue;
				}
				if (name !== "href" && name !== "action" && REMOTE_RE.test(value)) hasRemoteContent = true;
				if (name === "srcset" && /(^|,)\s*(https?:)?\/\//i.test(value)) hasRemoteContent = true;
			}
			if (name === "style" && CSS_REMOTE_RE.test(value)) hasRemoteContent = true;
		}
		// Make sure links never try to navigate the iframe itself.
		if (el.tagName === "A") {
			el.setAttribute("target", "_blank");
			// Show the real destination on hover (helps spot phishing links).
			const href = el.getAttribute("href");
			if (href && !el.hasAttribute("title")) el.setAttribute("title", href);
		}
	}
	doc.querySelectorAll("style").forEach((s) => {
		if (CSS_REMOTE_RE.test(s.textContent ?? "") || /@import/i.test(s.textContent ?? "")) hasRemoteContent = true;
	});
	doc.querySelectorAll("link[rel~='stylesheet' i]").forEach(() => (hasRemoteContent = true));

	const head = doc.head;
	const csp = doc.createElement("meta");
	csp.setAttribute("http-equiv", "Content-Security-Policy");
	csp.setAttribute(
		"content",
		opts.allowRemote
			? "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src * 'unsafe-inline'; font-src * data:"
			: "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:",
	);
	head.prepend(csp);

	const charset = doc.createElement("meta");
	charset.setAttribute("charset", "utf-8");
	head.prepend(charset);

	const style = doc.createElement("style");
	style.textContent = baseCss(opts.theme);
	head.prepend(style); // prepend so the email's own CSS wins

	return {
		srcdoc: "<!DOCTYPE html>\n" + doc.documentElement.outerHTML,
		hasRemoteContent,
		usedContentIds,
	};
}

function baseCss(theme: "light" | "adaptive"): string {
	const common = `
		html, body { margin: 0; padding: 0; }
		body { padding: 16px; overflow-wrap: anywhere; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.45; }
		img { max-width: 100%; height: auto; }
		pre { white-space: pre-wrap; }
		blockquote { margin-left: 0.5em; padding-left: 0.8em; border-left: 3px solid #ccc; }
	`;
	if (theme === "light") {
		return `:root { color-scheme: light; } body { background: #ffffff; color: #1f1f1f; } a { color: #0b57d0; }` + common;
	}
	const cs = getComputedStyle(activeDocument.body);
	const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
	return (
		`:root { color-scheme: ${activeDocument.body.hasClass("theme-dark") ? "dark" : "light"}; }
		 body { background: transparent; color: ${v("--text-normal", "inherit")}; }
		 a { color: ${v("--text-accent", "inherit")}; }` + common
	);
}
