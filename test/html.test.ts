import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { prepareHtml } from "../src/html";
import type { EmailAttachment } from "../src/parse";

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const logo: EmailAttachment = {
	filename: "logo.png",
	mimeType: "image/png",
	content: new Uint8Array([1]),
	contentId: "logo@x",
	inline: true,
};
// Browsers wrap bare fragments in <html><body>; linkedom doesn't, so do it here.
const wrap = (html: string) => (/<html/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`);
const prep = (html: string, allowRemote = false) =>
	prepareHtml(wrap(html), { allowRemote, theme: "light", attachments: [logo], resolveCid: () => "blob:fake/1" });

/** Parse the generated srcdoc again, the way the iframe will. */
const reparse = (srcdoc: string) => new DOMParser().parseFromString(srcdoc, "text/html");

test("strips scripts, handlers, javascript: links and meta refresh", () => {
	const { srcdoc } = prep(
		`<html><head><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://evil"></head>` +
			`<body onload="alert(2)"><a href="javascript:alert(3)">x</a><img src="x" onerror="alert(4)">` +
			`<iframe src="https://evil"></iframe><object data="x"></object></body></html>`,
	);
	assert.doesNotMatch(srcdoc, /alert|evil|<iframe|<object/i);
	const doc = reparse(srcdoc);
	assert.equal(doc.querySelector("a")!.getAttribute("href"), null);
});

test("CSP is the first element of <head> and cannot be displaced", () => {
	const tricky = `<html lang="de" data-x="<head><meta http-equiv='x'>"><head><title>t</title></head><body><p>hi</p></body></html>`;
	const doc = reparse(prep(tricky).srcdoc);
	const first = doc.head.children;
	assert.equal(first[0].getAttribute("charset"), "utf-8");
	assert.equal(first[1].getAttribute("http-equiv"), "Content-Security-Policy");
	assert.match(first[1].getAttribute("content")!, /img-src data: blob:;/);
	assert.equal(doc.documentElement.getAttribute("lang"), "de");
	assert.equal(doc.documentElement.getAttribute("data-x"), null, "other <html> attributes are dropped");
	assert.equal(doc.querySelector("p")!.textContent, "hi");
});

test("lang/dir values are escaped", () => {
	const doc = reparse(prep(`<html dir='rtl"><meta http-equiv=x'><body>x</body></html>`).srcdoc);
	assert.equal(doc.head.children[1].getAttribute("http-equiv"), "Content-Security-Policy");
	assert.equal(doc.querySelectorAll("meta").length, 2);
});

test("resolves cid images and reports which were used", () => {
	const r = prep(`<img src="cid:logo@x"><img src="cid:missing">`);
	const imgs = reparse(r.srcdoc).querySelectorAll("img");
	assert.equal(imgs[0].getAttribute("src"), "blob:fake/1");
	assert.equal(imgs[1].getAttribute("src"), "cid:missing");
	assert.deepEqual([...r.usedContentIds], ["logo@x"]);
});

test("detects remote content and only allows it on request", () => {
	assert.equal(prep(`<p>plain</p>`).hasRemoteContent, false);
	assert.equal(prep(`<img src="https://t.example/p.gif">`).hasRemoteContent, true);
	assert.equal(prep(`<div style="background:url(//t.example/x)">`).hasRemoteContent, true);
	assert.equal(prep(`<style>@import "https://t.example/a.css";</style>`).hasRemoteContent, true);
	assert.equal(prep(`<a href="https://example.com">link only</a>`).hasRemoteContent, false);
	const allowed = reparse(prep(`<p>x</p>`, true).srcdoc).head.children[1].getAttribute("content")!;
	assert.match(allowed, /img-src \* data: blob:/);
});

test("links open externally and show their target", () => {
	const a = reparse(prep(`<a href="https://example.com/x">go</a>`).srcdoc).querySelector("a")!;
	assert.equal(a.getAttribute("target"), "_blank");
	assert.equal(a.getAttribute("title"), "https://example.com/x");
});
