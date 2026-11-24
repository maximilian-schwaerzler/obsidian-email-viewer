import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEmailFile, splitMbox, summarizeEml, parseEml } from "../src/parse";

const fx = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), "test", "fixtures", name)));

test("rich multipart .eml", async () => {
	const e = await parseEmailFile(fx("rich.eml"), "eml");
	assert.equal(e.subject, "Quartalsbericht 📊 Q3");
	assert.deepEqual(e.from, [{ name: "Jürgen Müller", address: "juergen@example.com" }]);
	assert.deepEqual(e.to.map((a) => a.address), ["alice@example.org", "bob@example.org"]);
	assert.deepEqual(e.cc.map((a) => a.address), ["carol@example.org", "dave@example.org"], "groups are flattened");
	assert.equal(e.replyTo[0].address, "replies@example.com");
	assert.equal(e.date?.toISOString(), "2026-11-03T08:15:00.000Z");
	assert.match(e.text!, /Grüße!/);
	assert.match(e.html!, /cid:logo@example.com/);
	const logo = e.attachments.find((a) => a.contentId === "logo@example.com");
	assert.ok(logo, "inline image found");
	assert.equal(logo!.mimeType, "image/png");
	assert.equal(logo!.content[1], 0x50, "PNG magic decoded");
	const pdf = e.attachments.find((a) => a.mimeType === "application/pdf");
	assert.equal(pdf?.filename, "Bericht Q3 Übersicht.pdf", "RFC 2231 filename decoded");
	assert.ok(new TextDecoder().decode(pdf!.content).startsWith("%PDF"));
	assert.ok(e.headers.some((h) => h.key === "Message-ID"));
});

test("latin-1 plain .eml", async () => {
	const e = await parseEmailFile(fx("plain.eml"), "eml");
	assert.equal(e.html, undefined);
	assert.match(e.text!, /Café at noon/);
});

test(".emlx strips Apple framing and plist", async () => {
	const e = await parseEmailFile(fx("apple.emlx"), "emlx");
	assert.equal(e.subject, "Plain text only");
	assert.doesNotMatch(e.text!, /plist/);
});

test(".mbox splitting and From-unescaping", async () => {
	const msgs = splitMbox(fx("archive.mbox"));
	assert.equal(msgs.length, 3);
	const subjects = await Promise.all(msgs.map(async (m) => (await summarizeEml(m)).subject));
	assert.deepEqual(subjects, ["First message", "Second message", "Third"]);
	const first = await parseEml(msgs[0]);
	assert.match(first.text!, /^From the archive/m);
	assert.match(first.text!, /^>From double escaped/m);
	const second = await parseEml(msgs[1]);
	assert.match(second.html!, /<i>only<\/i>/);
	const s = await summarizeEml(msgs[1]);
	assert.equal(s.from[0].name, "Bob");
});

for (const name of ["sample.msg", "cjk.msg", "attach-eml.msg"]) {
	test(`Outlook ${name}`, async () => {
		const e = await parseEmailFile(fx(name), "msg");
		console.log(`   ${name}: subject=${JSON.stringify(e.subject)} from=${JSON.stringify(e.from)} to=${e.to.length} ` +
			`date=${e.date?.toISOString()} html=${!!e.html} text=${e.text?.length ?? 0}ch ` +
			`attachments=${JSON.stringify(e.attachments.map((a) => [a.filename, a.mimeType, a.content.length, a.contentId]))}`);
		assert.ok(e.subject.length > 0);
		if (name !== "cjk.msg") assert.ok(e.from.length > 0); // cjk.msg is an unsent draft
		assert.ok(e.html || e.text);
		if (name === "cjk.msg") assert.match(e.text!, /你好.*\n.*こんにちは.*\n.*안녕하세요/s);
		if (name === "sample.msg") assert.deepEqual(e.from[0], { name: "", address: "christoph@freiraum.xyz" });
		for (const a of e.attachments) assert.ok(a.content.length > 0);
	});
}
