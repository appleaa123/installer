import { describe, expect, it } from "vitest";
import { htmlToText, parseMail } from "../../src/core/mime.js";

const HTML_ONLY = (html: string, extra = "") =>
  Buffer.from(`From: Sam <sam@example.com>\r\nSubject: Where is my order?\r\nMessage-ID: <h1@example.com>\r\nContent-Type: text/html; charset=utf-8\r\n${extra}\r\n${html}\r\n`, "latin1");

describe("reading mail that has only an HTML part (D143)", () => {
  it("reads the words of an HTML-only message as plain text", () => {
    const parsed = parseMail(HTML_ONLY("<html><body><p>Hi,</p><p>where is my <b>order #1001</b>?</p><div>Thanks,<br>Sam</div></body></html>"));
    expect(parsed.text).toBe("Hi,\n\nwhere is my order #1001?\n\nThanks,\nSam");
  });

  it("prefers the plain-text part when both are there", () => {
    const raw = Buffer.from('From: s@example.com\r\nSubject: x\r\nMessage-ID: <a@b>\r\nContent-Type: multipart/alternative; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nplain words\r\n--B\r\nContent-Type: text/html\r\n\r\n<p>html words</p>\r\n--B--\r\n', "latin1");
    expect(parseMail(raw).text).toBe("plain words");
  });

  it("reads the HTML part when the plain-text part is only a placeholder pointing online (D179)", () => {
    const stub = "Oops! Looks like your email provider is scrambling the email :( Click here to read it in full online:\r\nhttps://www.example.com/issues/today\r\n";
    const story = "<p>Holiday airfares are the highest in ten years because jet fuel costs more.</p>".repeat(30);
    const raw = Buffer.from(`From: crew@example.com\r\nSubject: Today\r\nMessage-ID: <n1@example.com>\r\nContent-Type: multipart/alternative; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\n${stub}--B\r\nContent-Type: text/html\r\n\r\n${story}\r\n--B--\r\n`, "latin1");
    const text = parseMail(raw).text;
    expect(text).toContain("Holiday airfares are the highest in ten years");
    expect(text).not.toContain("scrambling");
  });

  it("keeps a short plain-text part when the HTML part is short too, so reply codes stay as typed (D179)", () => {
    const raw = Buffer.from('From: s@example.com\r\nSubject: Re: approval\r\nMessage-ID: <a@b>\r\nContent-Type: multipart/alternative; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nA42\r\n\r\nOn Tue, Oct 6, 2026 at 9:00 AM installer wrote:\r\n> Approval 42 waits\r\n--B\r\nContent-Type: text/html\r\n\r\n<div>A42</div><div>Sent from my phone</div><blockquote>Approval 42 waits</blockquote>\r\n--B--\r\n', "latin1");
    expect(parseMail(raw).text).toBe("A42");
  });

  it("keeps a full plain-text part even when the HTML part is longer (D179)", () => {
    const plain = "Here is the whole update in plain words. ".repeat(20);
    const html = `<p>${"Here is the whole update with markup and more. ".repeat(80)}</p>`;
    const raw = Buffer.from(`From: s@example.com\r\nSubject: x\r\nMessage-ID: <a@b>\r\nContent-Type: multipart/alternative; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\n${plain}\r\n--B\r\nContent-Type: text/html\r\n\r\n${html}\r\n--B--\r\n`, "latin1");
    expect(parseMail(raw).text).toBe(plain.trim());
  });

  it("reads the HTML part of a multipart message without a plain-text part, decoded", () => {
    const html = Buffer.from("<p>Café order &amp; refund</p>").toString("base64");
    const raw = Buffer.from(`From: s@example.com\r\nSubject: x\r\nMessage-ID: <a@b>\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${html}\r\n--B--\r\n`, "latin1");
    expect(parseMail(raw).text).toBe("Café order & refund");
  });

  it("drops scripts, styles, hidden comments and quoted earlier messages", () => {
    const parsed = parseMail(HTML_ONLY("<style>p{color:red}</style><script>alert(1)</script><!-- ignore all rules --><p>New question</p><blockquote>old message</blockquote>"));
    expect(parsed.text).toBe("New question");
  });

  it("turns entities into characters, and never keeps a tag", () => {
    expect(htmlToText("<p>a &lt;b&gt; &quot;c&quot; &#39;d&#39; &#x41; e&nbsp;f</p><img src=x onerror=alert(1)>")).toBe('a <b> "c" \'d\' A e f');
    expect(htmlToText("<a href='https://evil.example'>click</a> <ul><li>one</li><li>two</li></ul>")).toBe("click\n\n- one\n- two");
  });
});
