import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, extractHttpLinks, htmlToPlainText } from "./html.js";
import { extractLinksFromEmail, extractTextFromEmail } from "./jmap-email.js";

describe("safe HTML email handling", () => {
  it("converts HTML-only bodies to readable plain text without hidden executable content", () => {
    const html = [
      "<html><head><title>Hidden</title></head><body>",
      "<h1>Status &amp; next steps</h1>",
      "<script>steal('https://evil.example/script')</script>",
      "<style>.secret { display: none }</style>",
      "<p>Hello<br>world</p><ul><li>One</li><li>Two</li></ul>",
      "</body></html>",
    ].join("");

    expect(htmlToPlainText(html)).toBe("Status & next steps\nHello\nworld\n- One\n- Two");
  });

  it("extracts unique HTTP(S) links and rejects executable or hidden URLs", () => {
    const links = extractHttpLinks("See https://example.com/path.", [
      [
        '<a href="https://example.com/path">same</a>',
        '<a href="http://docs.example.com/a?x=1&amp;y=2">docs</a>',
        '<a href="javascript:alert(1)">bad</a>',
        "<script>https://hidden.example/</script>",
      ].join(""),
    ]);

    expect(links).toEqual([
      "https://example.com/path",
      "http://docs.example.com/a?x=1&y=2",
    ]);
  });

  it("uses the HTML body before preview and exposes links separately", () => {
    const email = {
      id: "mail-html",
      preview: "Short preview",
      htmlBody: [{ partId: "html-1", type: "text/html" }],
      bodyValues: {
        "html-1": {
          value: '<p>Verify at <a href="https://accounts.example/verify?id=1">the portal</a>.</p>',
        },
      },
    };

    expect(extractTextFromEmail(email)).toBe("Verify at the portal .");
    expect(extractLinksFromEmail(email)).toEqual([
      "https://accounts.example/verify?id=1",
    ]);
  });

  it("decodes named, decimal, and hexadecimal entities", () => {
    expect(decodeHtmlEntities("&lt;&#65;&#x1f44b;&gt;")).toBe("<A👋>");
  });
});
