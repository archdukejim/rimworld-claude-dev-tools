import * as fs from "fs";
import * as path from "path";

/**
 * A tiny local keyring for the secrets this server holds — GitHub PATs and Anthropic API keys.
 *
 * Replaces the old single-file-per-service scheme with a keys.json that holds MANY labelled keys
 * per service and tracks which one is active. Resolution (getGitHubToken / resolveAnthropicKey)
 * reads the active entry; the old single files are still read as a legacy fallback so nothing
 * breaks on upgrade. Stored under %LOCALAPPDATA%\RimAgentic\keys.json, mode 0600.
 */

export type KeyService = "github" | "anthropic";

export interface KeyEntry {
    label: string;        // unique per service; how the user names/selects a key
    value: string;        // the secret itself
    active: boolean;      // exactly one active per service (the one resolution uses)
    addedAt: string;      // ISO timestamp
    expiresAt?: string;   // optional ISO date the user supplies (PATs don't embed expiry)
    note?: string;        // optional free text ("RimSynapse org", "personal", …)
}

type Store = { [S in KeyService]?: KeyEntry[] };

const localAppData = () =>
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
const rimAgenticDir = () => path.join(localAppData(), "RimAgentic");
export const keystorePath = () => path.join(rimAgenticDir(), "keys.json");

function read(): Store {
    try {
        const raw = fs.readFileSync(keystorePath(), "utf8");
        const data = JSON.parse(raw);
        return data && typeof data === "object" ? data : {};
    } catch {
        return {};
    }
}

function write(store: Store): void {
    fs.mkdirSync(rimAgenticDir(), { recursive: true });
    fs.writeFileSync(keystorePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** All entries for a service (empty array if none). Includes secret values. */
export function listKeys(service: KeyService): KeyEntry[] {
    return read()[service] ?? [];
}

/** The active key's value for a service, or null if none is stored. */
export function getActiveKey(service: KeyService): string | null {
    const entries = read()[service] ?? [];
    const active = entries.find(e => e.active) ?? entries[0];
    return active?.value?.trim() || null;
}

export function isExpired(e: KeyEntry, nowIso: string): boolean {
    return !!e.expiresAt && e.expiresAt <= nowIso;
}

/**
 * Add or replace a key. A new key becomes the active one for its service. If `label` matches an
 * existing entry, that entry is updated in place (and made active). `nowIso` is passed in so the
 * caller controls the clock (the server passes new Date().toISOString()).
 */
export function addKey(
    service: KeyService,
    value: string,
    opts: { label?: string; note?: string; expiresAt?: string; nowIso: string }
): KeyEntry {
    const store = read();
    const entries = store[service] ?? [];
    const label = (opts.label?.trim()) || defaultLabel(service, entries);

    const existing = entries.find(e => e.label === label);
    const entry: KeyEntry = existing
        ? Object.assign(existing, { value: value.trim(), note: opts.note ?? existing.note, expiresAt: opts.expiresAt ?? existing.expiresAt })
        : { label, value: value.trim(), active: false, addedAt: opts.nowIso, note: opts.note, expiresAt: opts.expiresAt };

    if (!existing) entries.push(entry);
    for (const e of entries) e.active = e === entry; // new/updated key becomes the sole active
    store[service] = entries;
    write(store);
    return entry;
}

/** Delete a key by label. If it was active, the first remaining key is promoted. Returns true if removed. */
export function deleteKey(service: KeyService, label: string): boolean {
    const store = read();
    const entries = store[service] ?? [];
    const idx = entries.findIndex(e => e.label === label);
    if (idx === -1) return false;
    const wasActive = entries[idx].active;
    entries.splice(idx, 1);
    if (wasActive && entries.length && !entries.some(e => e.active)) entries[0].active = true;
    store[service] = entries;
    write(store);
    return true;
}

/** Make an existing key active. Returns false if the label isn't found. */
export function setActive(service: KeyService, label: string): boolean {
    const store = read();
    const entries = store[service] ?? [];
    if (!entries.some(e => e.label === label)) return false;
    for (const e of entries) e.active = e.label === label;
    store[service] = entries;
    write(store);
    return true;
}

function defaultLabel(service: KeyService, entries: KeyEntry[]): string {
    if (!entries.length) return "default";
    let n = entries.length + 1;
    let label = `${service}-${n}`;
    while (entries.some(e => e.label === label)) label = `${service}-${++n}`;
    return label;
}

/** Mask a secret for display: first 10 + last 4, never the middle. */
export function maskSecret(value: string): string {
    if (value.length <= 14) return `${value.slice(0, 3)}…`;
    return `${value.slice(0, 10)}…${value.slice(-4)}`;
}
