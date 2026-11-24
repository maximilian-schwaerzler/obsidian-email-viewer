/**
 * Format-agnostic email parsing.
 *
 * Every supported file type (.eml, .emlx, .mbox, .msg) is normalised into the
 * same `ParsedEmail` shape so the view only has to know how to render one thing.
 * This module has no dependency on the Obsidian API so it can be unit-tested in Node.
 */
import PostalMime from "postal-mime";
import type { Address, Email } from "postal-mime";
import MsgReader from "@kenjiuno/msgreader";
import type { FieldsData } from "@kenjiuno/msgreader";

export interface EmailAddress {
	name: string;
	address: string;
}

export interface EmailAttachment {
	filename: string;
	mimeType: string;
	content: Uint8Array;
	/** Content-ID without the surrounding angle brackets. */
	contentId?: string;
	/** The sender marked this part as inline / hidden. */
	inline: boolean;
}

export interface EmailHeader {
	key: string;
	value: string;
}

export interface ParsedEmail {
	subject: string;
	from: EmailAddress[];
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	replyTo: EmailAddress[];
	date: Date | null;
	/** Original date header, used when it can't be parsed. */
	dateRaw?: string;
	messageId?: string;
	html?: string;
	text?: string;
	attachments: EmailAttachment[];
	headers: EmailHeader[];
}

/** Lightweight summary used for the message list of an mbox file. */
export interface EmailSummary {
	subject: string;
	from: EmailAddress[];
	date: Date | null;
}

export const SUPPORTED_EXTENSIONS = ["eml", "emlx", "mbox", "msg"] as const;
export type EmailFormat = (typeof SUPPORTED_EXTENSIONS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenAddresses(input: Address | Address[] | undefined): EmailAddress[] {
	if (!input) return [];
	const list = Array.isArray(input) ? input : [input];
	const out: EmailAddress[] = [];
	for (const a of list) {
		if (a.group) {
			for (const m of a.group) out.push({ name: m.name ?? "", address: m.address ?? "" });
		} else {
			out.push({ name: a.name ?? "", address: a.address ?? "" });
		}
	}
	return out.filter((a) => a.name || a.address);
}

function toDate(value: string | undefined): Date | null {
	if (!value) return null;
	const d = new Date(value);
	return isNaN(d.getTime()) ? null : d;
}

function stripAngles(id: string | undefined): string | undefined {
	if (!id) return undefined;
	return id.trim().replace(/^<|>$/g, "");
}

function toUint8(content: ArrayBuffer | Uint8Array | string): Uint8Array {
	if (typeof content === "string") return new TextEncoder().encode(content);
	return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** Parse an RFC 5322 header block into key/value pairs (unfolding continuation lines). */
export function parseHeaderBlock(block: string): EmailHeader[] {
	const headers: EmailHeader[] = [];
	for (const line of block.split(/\r?\n/)) {
		if (/^[ \t]/.test(line) && headers.length) {
			headers[headers.length - 1].value += " " + line.trim();
			continue;
		}
		const idx = line.indexOf(":");
		if (idx > 0) headers.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
	}
	return headers;
}

// ---------------------------------------------------------------------------
// .eml (RFC 822 / MIME)
// ---------------------------------------------------------------------------

function fromPostal(email: Email): ParsedEmail {
	return {
		subject: email.subject ?? "",
		from: flattenAddresses(email.from),
		to: flattenAddresses(email.to),
		cc: flattenAddresses(email.cc),
		bcc: flattenAddresses(email.bcc),
		replyTo: flattenAddresses(email.replyTo),
		date: toDate(email.date),
		dateRaw: email.date,
		messageId: email.messageId,
		html: email.html,
		text: email.text,
		headers: email.headers.map((h) => ({ key: h.originalKey, value: h.value })),
		attachments: email.attachments.map((a, i) => ({
			filename: a.filename || defaultAttachmentName(a.mimeType, i),
			mimeType: a.mimeType || "application/octet-stream",
			content: toUint8(a.content),
			contentId: stripAngles(a.contentId),
			inline: a.disposition === "inline" || !!a.related,
		})),
	};
}

const MIME_EXTENSIONS: Record<string, string> = {
	"message/rfc822": "eml",
	"text/calendar": "ics",
	"text/plain": "txt",
	"text/html": "html",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"application/pdf": "pdf",
};

function defaultAttachmentName(mimeType: string, index: number): string {
	const ext = MIME_EXTENSIONS[mimeType] ?? "bin";
	return `attachment-${index + 1}.${ext}`;
}

export async function parseEml(bytes: Uint8Array): Promise<ParsedEmail> {
	const email = await PostalMime.parse(bytes, { attachmentEncoding: "arraybuffer" });
	return fromPostal(email);
}

// ---------------------------------------------------------------------------
// .emlx (Apple Mail): "<byte count>\n<RFC 822 message><XML plist>"
// ---------------------------------------------------------------------------

export function extractEmlx(bytes: Uint8Array): Uint8Array {
	const nl = bytes.indexOf(0x0a);
	if (nl > 0 && nl < 20) {
		const len = parseInt(new TextDecoder().decode(bytes.subarray(0, nl)).trim(), 10);
		if (!isNaN(len) && len > 0) return bytes.subarray(nl + 1, Math.min(bytes.length, nl + 1 + len));
	}
	return bytes; // Not really emlx framing – treat as plain eml.
}

// ---------------------------------------------------------------------------
// .mbox: messages separated by lines starting with "From "
// ---------------------------------------------------------------------------

const FROM_ = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "

function startsWithAt(bytes: Uint8Array, pos: number, seq: number[]): boolean {
	if (pos + seq.length > bytes.length) return false;
	for (let i = 0; i < seq.length; i++) if (bytes[pos + i] !== seq[i]) return false;
	return true;
}

/** Undo mboxrd/mboxo escaping: ">From " -> "From ", ">>From " -> ">From ". */
function unescapeFromLines(msg: Uint8Array): Uint8Array {
	const out: number[] = [];
	let changed = false;
	let lineStart = true;
	for (let i = 0; i < msg.length; i++) {
		if (lineStart && msg[i] === 0x3e /* > */) {
			let j = i;
			while (msg[j] === 0x3e) j++;
			if (startsWithAt(msg, j, FROM_)) {
				i++; // drop one '>'
				changed = true;
			}
		}
		out.push(msg[i]);
		lineStart = msg[i] === 0x0a;
	}
	return changed ? Uint8Array.from(out) : msg;
}

/** Split an mbox file into raw RFC 822 messages. */
export function splitMbox(bytes: Uint8Array): Uint8Array[] {
	const starts: number[] = [];
	for (let i = 0; i < bytes.length; i++) {
		if ((i === 0 || bytes[i - 1] === 0x0a) && startsWithAt(bytes, i, FROM_)) starts.push(i);
	}
	if (starts.length === 0) return bytes.length ? [bytes] : [];

	const messages: Uint8Array[] = [];
	for (let k = 0; k < starts.length; k++) {
		const begin = starts[k];
		const end = k + 1 < starts.length ? starts[k + 1] : bytes.length;
		const firstNl = bytes.indexOf(0x0a, begin);
		if (firstNl < 0 || firstNl >= end) continue; // separator line without body
		const msg = bytes.subarray(firstNl + 1, end);
		if (msg.length) messages.push(unescapeFromLines(msg));
	}
	return messages;
}

/** Fast summary: parses only the header section of a raw message. */
export async function summarizeEml(bytes: Uint8Array): Promise<EmailSummary> {
	let end = bytes.length;
	for (let i = 0; i < bytes.length - 1; i++) {
		if (bytes[i] === 0x0a && (bytes[i + 1] === 0x0a || (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a))) {
			end = i + 1;
			break;
		}
	}
	const email = await PostalMime.parse(bytes.subarray(0, end));
	return { subject: email.subject ?? "", from: flattenAddresses(email.from), date: toDate(email.date) };
}

// ---------------------------------------------------------------------------
// .msg (Outlook, OLE compound file)
// ---------------------------------------------------------------------------

function decodeWithCodepage(bytes: Uint8Array, codepage: number | undefined): string {
	const label = !codepage || codepage === 65001 ? "utf-8" : codepage === 20127 ? "us-ascii" : `windows-${codepage}`;
	try {
		return new TextDecoder(label).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

function msgAddress(name: string | undefined, ...candidates: (string | undefined)[]): EmailAddress {
	// Exchange-internal addresses look like "/O=ORG/OU=..."; prefer a real SMTP one.
	const address = candidates.find((c) => c && c.includes("@") && !c.startsWith("/")) ?? candidates.find(Boolean) ?? "";
	// Outlook often stores the address as the display name too; don't show it twice.
	return { name: name && name !== address ? name : "", address };
}

export function parseMsg(bytes: Uint8Array): ParsedEmail {
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const reader = new MsgReader(buffer);
	const data = reader.getFileData();
	if (data.error) throw new Error(`Could not read .msg file: ${data.error}`);

	const recipients = (type: "to" | "cc" | "bcc") =>
		(data.recipients ?? [])
			.filter((r) => (r.recipType ?? "to") === type)
			.map((r) => msgAddress(r.name, r.smtpAddress, r.email));

	const headers = data.headers ? parseHeaderBlock(data.headers) : [];
	const dateRaw = data.clientSubmitTime ?? data.messageDeliveryTime ?? data.creationTime;

	let html = data.bodyHtml;
	if (!html && data.html) html = decodeWithCodepage(data.html, data.internetCodepage);

	const attachments: EmailAttachment[] = [];
	(data.attachments ?? []).forEach((a: FieldsData, i: number) => {
		try {
			const att = reader.getAttachment(a);
			attachments.push({
				filename: att.fileName || a.fileName || a.fileNameShort || a.name || defaultAttachmentName("", i),
				mimeType: a.attachMimeTag || (a.innerMsgContent ? "application/vnd.ms-outlook" : "application/octet-stream"),
				content: att.content,
				contentId: stripAngles(a.pidContentId),
				inline: !!a.attachmentHidden,
			});
		} catch (e) {
			console.warn("Email Viewer: failed to extract .msg attachment", e);
		}
	});

	const replyToHeader = headers.find((h) => h.key.toLowerCase() === "reply-to")?.value;

	return {
		subject: data.subject ?? "",
		from: [msgAddress(data.senderName, data.senderSmtpAddress, data.sentRepresentingSmtpAddress, data.senderEmail)].filter(
			(a) => a.name || a.address,
		),
		to: recipients("to"),
		cc: recipients("cc"),
		bcc: recipients("bcc"),
		replyTo: replyToHeader ? [{ name: "", address: replyToHeader }] : [],
		date: toDate(dateRaw),
		dateRaw,
		messageId: headers.find((h) => h.key.toLowerCase() === "message-id")?.value,
		html,
		text: data.body,
		attachments,
		headers,
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function parseEmailFile(bytes: Uint8Array, ext: string): Promise<ParsedEmail> {
	switch (ext.toLowerCase()) {
		case "msg":
			return parseMsg(bytes);
		case "emlx":
			return parseEml(extractEmlx(bytes));
		default:
			return parseEml(bytes);
	}
}
