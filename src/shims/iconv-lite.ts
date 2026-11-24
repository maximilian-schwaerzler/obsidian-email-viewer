/**
 * Minimal browser replacement for `iconv-lite`, which @kenjiuno/msgreader pulls in.
 * The real package needs Node's Buffer/stream modules (unavailable on Obsidian mobile)
 * and adds ~600 KB of codepage tables. TextDecoder covers everything msgreader needs.
 */
export function decode(bytes: Uint8Array, encoding: string): string {
	try {
		return new TextDecoder(encoding).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

export function encode(text: string, encoding: string): Uint8Array {
	const enc = encoding.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (enc === "utf16le" || enc === "ucs2") {
		const out = new Uint8Array(text.length * 2);
		for (let i = 0; i < text.length; i++) {
			const c = text.charCodeAt(i);
			out[i * 2] = c & 0xff;
			out[i * 2 + 1] = c >> 8;
		}
		return out;
	}
	return new TextEncoder().encode(text);
}

export default { decode, encode };
