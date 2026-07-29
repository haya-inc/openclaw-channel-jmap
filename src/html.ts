const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function decodeCodePoint(raw: string, radix: number): string {
  const value = Number.parseInt(raw, radix);
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) {
    return "\uFFFD";
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return "\uFFFD";
  }
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_match, raw: string) => decodeCodePoint(raw, 16))
    .replace(/&#([0-9]+);?/g, (_match, raw: string) => decodeCodePoint(raw, 10))
    .replace(/&([a-z]+);/gi, (match, raw: string) => NAMED_ENTITIES[raw.toLowerCase()] ?? match);
}

function stripHiddenHtml(html: string): string {
  return html
    .replace(/<(script|style|template|noscript|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    stripHiddenHtml(html)
      .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)\s*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}(?=- )/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeHttpUrl(raw: string): string | null {
  const decoded = decodeHtmlEntities(raw.trim()).replace(/[)\].,;:!?"'>}]+$/g, "");
  if (!/^https?:\/\//i.test(decoded)) {
    return null;
  }
  try {
    const parsed = new URL(decoded);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function extractHttpLinks(text: string, htmlParts: string[] = []): string[] {
  const links = new Set<string>();
  const add = (raw: string) => {
    const normalized = normalizeHttpUrl(raw);
    if (normalized && links.size < 100) {
      links.add(normalized);
    }
  };

  for (const html of htmlParts) {
    const visibleHtml = stripHiddenHtml(html);
    for (const match of visibleHtml.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      add(match[1] ?? match[2] ?? match[3] ?? "");
    }
  }
  for (const source of [text, ...htmlParts.map(stripHiddenHtml)]) {
    for (const match of source.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
      add(match[0]);
    }
  }

  return [...links];
}
