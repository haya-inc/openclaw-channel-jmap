function trimPrefix(value) {
    let next = value.trim();
    if (next.toLowerCase().startsWith("jmap:")) {
        next = next.slice("jmap:".length).trim();
    }
    return next;
}
export function normalizeEmailAddress(raw) {
    const value = (raw ?? "").trim().toLowerCase();
    if (!value) {
        return "";
    }
    return value;
}
export function normalizeJmapTarget(raw) {
    const trimmed = trimPrefix(raw);
    if (!trimmed) {
        return undefined;
    }
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("thread:")) {
        const id = trimmed.slice("thread:".length).trim();
        return id ? `thread:${id.toLowerCase()}` : undefined;
    }
    if (lower.startsWith("email:")) {
        const email = normalizeEmailAddress(trimmed.slice("email:".length));
        return email || undefined;
    }
    if (lower.startsWith("user:")) {
        const email = normalizeEmailAddress(trimmed.slice("user:".length));
        return email || undefined;
    }
    if (trimmed.includes("@")) {
        const email = normalizeEmailAddress(trimmed);
        return email || undefined;
    }
    return `thread:${trimmed.toLowerCase()}`;
}
export function isJmapThreadTarget(target) {
    return target.toLowerCase().startsWith("thread:");
}
export function parseJmapThreadTarget(target) {
    if (!isJmapThreadTarget(target)) {
        return null;
    }
    const id = target.slice("thread:".length).trim();
    return id ? id.toLowerCase() : null;
}
export function looksLikeEmailAddress(raw) {
    const trimmed = raw.trim();
    if (!trimmed.includes("@")) {
        return false;
    }
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
//# sourceMappingURL=normalize.js.map