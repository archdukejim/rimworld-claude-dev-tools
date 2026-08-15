import * as fsp from "fs/promises";
import * as path from "path";
import * as http from "http";
import { createHash, randomBytes } from "crypto";
import { addKey, getActiveKey, listKeys } from "../keystore";
import { openUrl } from "./chromeCtl";

/*
 * Imgur uploads — turn locally generated images into hosted URLs for Steam Workshop descriptions.
 * ----------------------------------------------------------------------------------------------
 * Steam BBCode can only embed images by URL, so everything this server generates (capture_*,
 * render_workshop_infographic, merge_workshop_tiles, the showcase gallery) is unusable in a
 * description until it is hosted somewhere. compose_workshop_bbcode already recommends imgur
 * (i.imgur.com links are ~3x shorter than Steam-hosted ones, which matters against the ~8,000-char
 * description cap). This family closes that loop: local file -> imgur -> {url, caption} pairs that
 * feed straight into compose_workshop_bbcode -> swh_update_description.
 *
 * Two auth modes:
 *   - ACCOUNT (what you want): OAuth2 against your imgur account, so uploads land in your account,
 *     can be albumed, and can be managed/deleted from imgur.com. imgur_login does the whole dance.
 *   - ANONYMOUS: a bare Client-ID. No account, no callback URL, no secret. Images are only
 *     recoverable via their deletehash (which the local ledger keeps). Fine for throwaway shots.
 *
 * Credentials live in the shared keyring (%LOCALAPPDATA%\RimAgentic\keys.json, mode 0600) under the
 * "imgur" service as a JSON blob, so multiple accounts work exactly like multiple GitHub PATs
 * (list_keys / set_active_key / delete_key).
 *
 * Every successful upload is recorded in a local ledger keyed by file CONTENT hash. Re-uploading a
 * byte-identical image returns the existing link instead of burning a second upload against imgur's
 * daily quota — re-running a workshop-page build is cheap and idempotent.
 */

// Overridable so the upload/album/delete paths can be exercised against a stub server in tests
// without touching imgur or burning quota. Unset in normal use.
const API = process.env.IMGUR_API_BASE || "https://api.imgur.com";
const DEFAULT_CALLBACK_PORT = 8788;
const CALLBACK_PATH = "/imgur/callback";
const LOGIN_TIMEOUT_MS = 180_000;
const SOFT_SIZE_LIMIT = 10 * 1024 * 1024; // imgur's documented API limit for non-animated images
const HARD_SIZE_LIMIT = 20 * 1024 * 1024;

function localAppData(): string {
    return process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
}
const imgurDir = () => path.join(localAppData(), "RimAgentic", "imgur");
const ledgerPath = () => path.join(imgurDir(), "uploads.json");
const showcaseManifestPath = () => path.join(localAppData(), "RimAgentic", "showcase", "showcase.json");

// ---------------------------------------------------------------------------- credentials

interface ImgurCreds {
    clientId: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;        // ISO; when accessToken goes stale
    accountUsername?: string;
    accountId?: number;
}

function readCreds(): ImgurCreds | null {
    const raw = getActiveKey("imgur");
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        return o && typeof o.clientId === "string" && o.clientId ? o as ImgurCreds : null;
    } catch { return null; }
}

function writeCreds(c: ImgurCreds, label?: string): void {
    addKey("imgur", JSON.stringify(c), {
        label: label || c.accountUsername || undefined,
        note: c.accountUsername ? `imgur account @${c.accountUsername}` : "imgur client-id only (anonymous uploads)",
        nowIso: new Date().toISOString()
    });
}

/** Refresh the access token when it's missing/expiring. Returns the (possibly updated) creds. */
async function ensureAccessToken(c: ImgurCreds): Promise<ImgurCreds> {
    if (!c.refreshToken || !c.clientSecret) return c;
    const expMs = c.expiresAt ? Date.parse(c.expiresAt) : 0;
    if (c.accessToken && expMs && expMs - Date.now() > 5 * 60_000) return c;

    const body = new URLSearchParams({
        refresh_token: c.refreshToken,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: "refresh_token"
    });
    const res = await fetch(`${API}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.access_token) {
        throw new Error(
            `imgur refused to refresh the access token (HTTP ${res.status}: ${json?.data?.error || json?.error || "unknown"}). ` +
            `Run imgur_login again to re-authorize.`
        );
    }
    const updated: ImgurCreds = {
        ...c,
        accessToken: json.access_token,
        refreshToken: json.refresh_token || c.refreshToken,
        expiresAt: new Date(Date.now() + (Number(json.expires_in) || 315_360_000) * 1000).toISOString(),
        accountUsername: json.account_username || c.accountUsername,
        accountId: json.account_id ?? c.accountId
    };
    writeCreds(updated, activeLabel() || undefined);
    return updated;
}

function activeLabel(): string | null {
    return listKeys("imgur").find(e => e.active)?.label ?? null;
}

/**
 * Pick the Authorization header for a call. Account mode when we hold a usable token and the caller
 * didn't force anonymous; otherwise Client-ID.
 */
async function authorize(anonymous: boolean): Promise<{ header: string; mode: "account" | "anonymous"; creds: ImgurCreds }> {
    const creds = readCreds();
    if (!creds) {
        throw new Error(
            "No imgur credentials stored. Run imgur_login (see its description for the 60-second app registration), " +
            "or imgur_login { clientId, anonymousOnly: true } for anonymous uploads with no account."
        );
    }
    if (!anonymous && creds.refreshToken) {
        const fresh = await ensureAccessToken(creds);
        if (fresh.accessToken) return { header: `Bearer ${fresh.accessToken}`, mode: "account", creds: fresh };
    }
    return { header: `Client-ID ${creds.clientId}`, mode: "anonymous", creds };
}

// ---------------------------------------------------------------------------- ledger

interface UploadRecord {
    id: string;
    link: string;
    deletehash?: string;
    sha256: string;
    source: string;          // absolute path of the file we uploaded
    bytes: number;
    width?: number;
    height?: number;
    title?: string;
    caption?: string;        // carried through from a showcase entry, for compose_workshop_bbcode
    mod?: string;
    album?: string;          // album id it was filed under
    account?: string;        // imgur username, or "anonymous"
    uploadedAt: string;
}

interface Ledger {
    version: 1;
    uploads: UploadRecord[];
    albums: Record<string, { id: string; deletehash?: string; title: string; createdAt: string }>; // keyed by lowercased title
}

async function readLedger(): Promise<Ledger> {
    try {
        const txt = await fsp.readFile(ledgerPath(), "utf8");
        const o = JSON.parse(txt);
        return { version: 1, uploads: Array.isArray(o?.uploads) ? o.uploads : [], albums: o?.albums && typeof o.albums === "object" ? o.albums : {} };
    } catch { return { version: 1, uploads: [], albums: {} }; }
}

async function writeLedger(l: Ledger): Promise<void> {
    await fsp.mkdir(imgurDir(), { recursive: true });
    await fsp.writeFile(ledgerPath(), JSON.stringify(l, null, 2), "utf8");
}

// ---------------------------------------------------------------------------- imgur API

interface ImgurCallResult { json: any; rate: Record<string, string | null>; }

async function imgurCall(pathname: string, init: RequestInit & { header: string }): Promise<ImgurCallResult> {
    const { header, ...rest } = init;
    const res = await fetch(`${API}${pathname}`, {
        ...rest,
        headers: { Authorization: header, ...(rest.headers as any || {}) }
    });
    const json: any = await res.json().catch(() => ({}));
    const rate = {
        clientRemaining: res.headers.get("x-ratelimit-clientremaining"),
        userRemaining: res.headers.get("x-ratelimit-userremaining"),
        postRemaining: res.headers.get("x-post-rate-limit-remaining")
    };
    if (!res.ok || json?.success === false) {
        const err = json?.data?.error;
        const msg = typeof err === "string" ? err : (err?.message || JSON.stringify(json?.data || json || {}));
        throw new Error(`imgur ${pathname} failed (HTTP ${res.status}): ${msg}`);
    }
    return { json, rate };
}

/** Resolve an `album` argument (an album id, or a title to find-or-create) to an album id. */
async function resolveAlbum(album: string, header: string, mode: string): Promise<{ id: string; created: boolean }> {
    const ledger = await readLedger();
    const key = album.trim().toLowerCase();
    if (ledger.albums[key]) return { id: ledger.albums[key].id, created: false };
    // A bare imgur album id is 5-8 url-safe chars with no spaces — treat that as an id, not a title.
    if (/^[A-Za-z0-9]{5,10}$/.test(album.trim()) && !/\s/.test(album)) return { id: album.trim(), created: false };
    if (mode !== "account") {
        throw new Error(`Creating an album named "${album}" needs account mode — anonymous uploads can't own albums. Run imgur_login, or drop the album argument.`);
    }
    const body = new URLSearchParams({ title: album.trim(), privacy: "hidden" });
    const { json } = await imgurCall("/3/album", { method: "POST", header, body });
    const rec = { id: json.data.id, deletehash: json.data.deletehash, title: album.trim(), createdAt: new Date().toISOString() };
    ledger.albums[key] = rec;
    await writeLedger(ledger);
    return { id: rec.id, created: true };
}

// ---------------------------------------------------------------------------- tool definitions

export const imgurTools = [
    {
        name: "imgur_login",
        description:
            "Authorize this server against YOUR imgur account (OAuth2) so uploads land in your account and can be " +
            "albumed/managed — or store a bare Client-ID for anonymous uploads. Opens imgur's consent page in the " +
            "RimAgentic Chrome (launching it if needed, so you don't have to open a browser), catches the redirect on a " +
            "loopback port, and saves the tokens to the local keyring (never shown in chat, never committed); the " +
            "refresh token is reused automatically so this is a one-time step. " +
            "FIRST TIME: register an app at https://api.imgur.com/oauth2/addclient — pick 'OAuth 2 authorization with " +
            "a callback URL' and set the callback to exactly http://localhost:8788/imgur/callback — then pass the " +
            "clientId + clientSecret it gives you. Supports multiple accounts via `label` (switch with set_active_key).",
        inputSchema: {
            type: "object",
            properties: {
                clientId: { type: "string", description: "Your imgur application's Client ID. Required the first time; reused from the keyring afterwards." },
                clientSecret: { type: "string", description: "Your imgur application's Client Secret. Required for account (OAuth) mode." },
                anonymousOnly: { type: "boolean", description: "Skip OAuth entirely: store just the clientId and upload anonymously (no account, no callback URL needed). Default false." },
                port: { type: "number", description: `Loopback port for the OAuth callback (default ${DEFAULT_CALLBACK_PORT}). Must match the callback URL registered on the imgur app.` },
                code: { type: "string", description: "Complete a login manually by pasting the ?code=… value from the redirect URL, if the browser couldn't reach the loopback server." },
                label: { type: "string", description: "Name this credential (e.g. 'archdukejim'). Defaults to the imgur username. Use set_active_key to switch between accounts." }
            }
        }
    },
    {
        name: "imgur_status",
        description:
            "Report imgur auth state: which account is active (or anonymous mode), whether the access token is valid " +
            "and when it expires, remaining API/upload quota, and how many uploads the local ledger holds. Read-only — " +
            "call this first when an upload fails, before re-running imgur_login.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "imgur_upload",
        description:
            "Upload one or more local images to imgur and return their hosted URLs, ready for Steam Workshop " +
            "descriptions. Feed it explicit file paths, or pull straight from the showcase gallery (mod / showcaseIds) " +
            "so passing UI-test evidence becomes a description without a manual step. The result includes a " +
            "`bbcodeImages` array of {url, caption} you can hand directly to compose_workshop_bbcode. Uploads are " +
            "deduplicated by file CONTENT hash — re-uploading an unchanged image returns the existing link instead of " +
            "burning quota, so rebuilding a workshop page is idempotent (pass force:true to override).",
        inputSchema: {
            type: "object",
            properties: {
                paths: { type: "array", items: { type: "string" }, description: "Image file paths to upload, in order (e.g. render_workshop_infographic / merge_workshop_tiles / capture_* output)." },
                path: { type: "string", description: "Convenience single-file form of `paths`." },
                mod: { type: "string", description: "Upload every showcase item tagged with this mod (from showcase_list), carrying each item's caption through to the result." },
                showcaseIds: { type: "array", items: { type: "string" }, description: "Upload specific showcase entries by id." },
                title: { type: "string", description: "Title applied to each uploaded image on imgur. Optional." },
                description: { type: "string", description: "Description applied to each uploaded image on imgur. Optional." },
                album: { type: "string", description: "File the uploads under an album — an existing album id, or a title to find-or-create (account mode only). Good for one album per mod." },
                anonymous: { type: "boolean", description: "Force an anonymous upload even when an account is authorized. Default false." },
                force: { type: "boolean", description: "Re-upload even if a byte-identical image is already in the ledger. Default false." }
            }
        }
    },
    {
        name: "imgur_list_uploads",
        description:
            "List images this server has uploaded to imgur (the local ledger): link, imgur id, deletehash, source file, " +
            "caption, mod, album, and when. Filter by mod or album. This is the record of what a Workshop description " +
            "points at — and the only way to recover an anonymous upload's deletehash. Read-only.",
        inputSchema: {
            type: "object",
            properties: {
                mod: { type: "string", description: "Only uploads tagged with this mod." },
                album: { type: "string", description: "Only uploads filed under this album id or title." },
                limit: { type: "number", description: "Max rows to return, newest first (default 50)." }
            }
        }
    },
    {
        name: "imgur_delete",
        description:
            "Delete an uploaded image from imgur by its deletehash, imgur id, or i.imgur.com link (resolved through the " +
            "local ledger) and drop it from the ledger. Irreversible — and any Workshop description still embedding that " +
            "URL will show a broken image, so update the description first.",
        inputSchema: {
            type: "object",
            properties: {
                ref: { type: "string", description: "The deletehash, imgur id, or full i.imgur.com link of the image to delete." }
            },
            required: ["ref"]
        }
    }
];

// ---------------------------------------------------------------------------- dispatch

export async function handleImgurTool(name: string, args: any) {
    if (name === "imgur_login") return await login(args || {});
    if (name === "imgur_status") return await status();
    if (name === "imgur_upload") return await upload(args || {});
    if (name === "imgur_list_uploads") return await listUploads(args || {});
    if (name === "imgur_delete") return await deleteImage(args || {});
    throw new Error(`Unknown imgur tool: ${name}`);
}

// ---------------------------------------------------------------------------- imgur_login

async function login(args: any) {
    const existing = readCreds();
    const clientId = String(args.clientId || existing?.clientId || "").trim();
    const clientSecret = String(args.clientSecret || existing?.clientSecret || "").trim();
    const label = args.label ? String(args.label).trim() : undefined;

    if (!clientId) {
        return errText(
            "No clientId. Register an imgur application first (takes about a minute):\n" +
            "  1. Go to https://api.imgur.com/oauth2/addclient\n" +
            "  2. Authorization type: 'OAuth 2 authorization with a callback URL'\n" +
            `  3. Callback URL: http://localhost:${Number(args.port) || DEFAULT_CALLBACK_PORT}${CALLBACK_PATH}\n` +
            "  4. Re-run: imgur_login { clientId: \"...\", clientSecret: \"...\" }\n" +
            "For anonymous uploads with no account, any Client-ID works: imgur_login { clientId, anonymousOnly: true }."
        );
    }

    if (args.anonymousOnly) {
        writeCreds({ ...(existing || {}), clientId, clientSecret: clientSecret || undefined }, label);
        return okText({
            ok: true, mode: "anonymous", clientId: mask(clientId),
            note: "Stored. Uploads will be anonymous (not tied to an account); their deletehash is kept in the local ledger, which is the only way to delete them later."
        });
    }

    if (!clientSecret) {
        return errText("Account mode needs clientSecret too (from https://api.imgur.com/oauth2/addclient). Or pass anonymousOnly:true to upload without an account.");
    }

    const port = Number(args.port) > 0 ? Math.round(Number(args.port)) : DEFAULT_CALLBACK_PORT;
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    // Manual completion path: the user pasted the ?code= from a redirect we never received.
    if (args.code) {
        const creds = await exchangeCode(String(args.code).trim(), clientId, clientSecret);
        writeCreds(creds, label);
        return okText({ ok: true, mode: "account", account: creds.accountUsername, expiresAt: creds.expiresAt, note: "Authorized from a manually supplied code. Tokens saved to the keyring; the refresh token is reused automatically." });
    }

    const state = randomBytes(16).toString("hex");
    const authUrl = `${API}/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&state=${state}`;

    let code: string;
    try {
        code = await awaitCallback(port, state, authUrl);
    } catch (e: any) {
        return errText(
            `${e?.message || e}\n\n` +
            `Fallback: open this URL yourself, approve, then copy the "code" query parameter out of the redirect URL and run\n` +
            `  imgur_login { code: "<the code>" }\n\n${authUrl}`
        );
    }

    let creds: ImgurCreds;
    try { creds = await exchangeCode(code, clientId, clientSecret); }
    catch (e: any) { return errText(`Got the authorization code but the token exchange failed: ${e?.message || e}`); }

    writeCreds(creds, label);
    return okText({
        ok: true, mode: "account", account: creds.accountUsername, accountId: creds.accountId,
        expiresAt: creds.expiresAt, label: activeLabel(),
        note: "Authorized and saved to the keyring. The refresh token renews the access token automatically — you shouldn't need to run this again."
    });
}

async function exchangeCode(code: string, clientId: string, clientSecret: string): Promise<ImgurCreds> {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code });
    const res = await fetch(`${API}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.access_token) {
        throw new Error(`HTTP ${res.status}: ${json?.data?.error || json?.error || JSON.stringify(json)}`);
    }
    return {
        clientId, clientSecret,
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: new Date(Date.now() + (Number(json.expires_in) || 315_360_000) * 1000).toISOString(),
        accountUsername: json.account_username,
        accountId: json.account_id
    };
}

/** Bind a one-shot loopback server, open the browser at `authUrl`, and resolve with the ?code=. */
function awaitCallback(port: number, state: string, authUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url || "/", `http://localhost:${port}`);
            if (url.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return; }

            const code = url.searchParams.get("code");
            const gotState = url.searchParams.get("state");
            const error = url.searchParams.get("error");
            const fail = error ? `imgur denied the authorization: ${error}`
                : !code ? "The redirect carried no authorization code."
                    : gotState !== state ? "State mismatch on the OAuth callback — ignoring it as a possible forgery."
                        : null;

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(page(fail));
            cleanup();
            fail ? reject(new Error(fail)) : resolve(code!);
        });

        const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out after ${LOGIN_TIMEOUT_MS / 1000}s waiting for the imgur redirect.`)); }, LOGIN_TIMEOUT_MS);
        const cleanup = () => { clearTimeout(timer); try { server.close(); } catch { /* already closing */ } };

        server.on("error", (e: any) => {
            cleanup();
            reject(new Error(
                e?.code === "EADDRINUSE"
                    ? `Port ${port} is already in use, so the OAuth callback can't be caught. Free it, or register a different callback port on the imgur app and pass port:<n>.`
                    : `Couldn't start the loopback callback server: ${e?.message || e}`
            ));
        });

        // 127.0.0.1 only — nothing is exposed to the network, same posture as the Steam bridge.
        server.listen(port, "127.0.0.1", () => {
            // Consent goes through the RimAgentic Chrome (launching it if it isn't up) so the user
            // never has to open a browser themselves, and so the imgur session lands in the same
            // profile the browser-driven tools use. Falls back to the default browser.
            openUrl(authUrl).then(r => {
                if (!r.ok) console.error("[imgur] couldn't open a browser automatically:", r.error);
            });
        });
    });
}

function page(error: string | null): string {
    const title = error ? "Authorization failed" : "Authorized";
    const body = error ? error : "RimAgentic is connected to your imgur account. You can close this tab.";
    return `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font:15px/1.5 system-ui,sans-serif;padding:3rem;max-width:34rem;margin:auto">` +
        `<h1 style="font-size:1.3rem">${title}</h1><p>${body}</p></body>`;
}

// ---------------------------------------------------------------------------- imgur_status

async function status() {
    const creds = readCreds();
    const ledger = await readLedger();
    if (!creds) {
        return okText({
            authorized: false,
            note: "No imgur credentials stored. Run imgur_login — its description has the app-registration steps.",
            ledgerUploads: ledger.uploads.length
        });
    }

    const out: any = {
        authorized: true,
        label: activeLabel(),
        clientId: mask(creds.clientId),
        mode: creds.refreshToken ? "account" : "anonymous",
        account: creds.accountUsername ?? null,
        accessTokenExpiresAt: creds.expiresAt ?? null,
        ledgerUploads: ledger.uploads.length,
        albums: Object.values(ledger.albums).map(a => ({ title: a.title, id: a.id }))
    };

    try {
        const { header, mode } = await authorize(false);
        out.mode = mode;
        const { json, rate } = await imgurCall("/3/credits", { method: "GET", header });
        out.quota = {
            clientRemaining: json?.data?.ClientRemaining ?? rate.clientRemaining,
            userRemaining: json?.data?.UserRemaining ?? rate.userRemaining,
            userResetAt: json?.data?.UserReset ? new Date(json.data.UserReset * 1000).toISOString() : null
        };
        out.live = true;
    } catch (e: any) {
        out.live = false;
        out.error = e?.message || String(e);
    }
    return okText(out);
}

// ---------------------------------------------------------------------------- imgur_upload

interface Job { file: string; caption?: string; mod?: string; }

async function upload(args: any) {
    // Assemble the work list: explicit paths first, then anything pulled from the showcase gallery.
    const jobs: Job[] = [];
    const explicit = [
        ...(Array.isArray(args.paths) ? args.paths : []),
        ...(args.path ? [args.path] : [])
    ].map(String).filter(Boolean);
    for (const f of explicit) jobs.push({ file: path.resolve(f) });

    if (args.mod || (Array.isArray(args.showcaseIds) && args.showcaseIds.length)) {
        let entries: any[];
        try {
            entries = JSON.parse(await fsp.readFile(showcaseManifestPath(), "utf8"));
            if (!Array.isArray(entries)) entries = [];
        } catch {
            return errText(`No showcase gallery found at ${showcaseManifestPath()} — add items with showcase_add first, or pass explicit paths.`);
        }
        const wantIds: string[] = (args.showcaseIds || []).map(String);
        const modKey = args.mod ? String(args.mod).toLowerCase() : null;
        const picked = entries.filter(e =>
            (wantIds.length && wantIds.includes(e.id)) ||
            (modKey && String(e.mod || "").toLowerCase() === modKey)
        );
        if (!picked.length) {
            return errText(`No showcase items matched${args.mod ? ` mod "${args.mod}"` : ""}${wantIds.length ? ` ids [${wantIds.join(", ")}]` : ""}. Run showcase_list to see what's stored.`);
        }
        for (const e of picked) jobs.push({ file: e.path, caption: e.caption, mod: e.mod });
    }

    if (!jobs.length) return errText("Nothing to upload — pass `paths` / `path`, or `mod` / `showcaseIds` to pull from the showcase gallery.");

    const anonymous = !!args.anonymous;
    let header: string, mode: "account" | "anonymous", creds: ImgurCreds;
    try { ({ header, mode, creds } = await authorize(anonymous)); }
    catch (e: any) { return errText(e?.message || String(e)); }

    let albumId: string | undefined;
    let albumCreated = false;
    if (args.album) {
        try {
            const r = await resolveAlbum(String(args.album), header, mode);
            albumId = r.id; albumCreated = r.created;
        } catch (e: any) { return errText(e?.message || String(e)); }
    }

    const ledger = await readLedger();
    const results: any[] = [];
    let rate: Record<string, string | null> = {};

    for (const job of jobs) {
        let buf: Buffer;
        try { buf = await fsp.readFile(job.file); }
        catch { results.push({ file: job.file, ok: false, error: "File not found or unreadable." }); continue; }

        if (buf.length > HARD_SIZE_LIMIT) {
            results.push({ file: job.file, ok: false, error: `${(buf.length / 1048576).toFixed(1)} MB exceeds imgur's 20 MB ceiling. Downscale it (showcase_add / make_workshop_image both re-encode).` });
            continue;
        }

        const sha256 = createHash("sha256").update(buf).digest("hex");
        if (!args.force) {
            const hit = ledger.uploads.find(u => u.sha256 === sha256);
            if (hit) {
                results.push({ file: job.file, ok: true, reused: true, link: hit.link, id: hit.id, deletehash: hit.deletehash, caption: job.caption ?? hit.caption, uploadedAt: hit.uploadedAt });
                continue;
            }
        }

        const body = new URLSearchParams({ image: buf.toString("base64"), type: "base64" });
        body.set("name", path.basename(job.file));
        if (args.title) body.set("title", String(args.title));
        if (args.description) body.set("description", String(args.description));
        else if (job.caption) body.set("description", job.caption);
        if (albumId) body.set("album", albumId);

        try {
            const r = await imgurCall("/3/upload", { method: "POST", header, body });
            rate = r.rate;
            const d = r.json?.data || {};
            const rec: UploadRecord = {
                id: d.id, link: d.link, deletehash: d.deletehash, sha256,
                source: job.file, bytes: buf.length, width: d.width, height: d.height,
                title: args.title ? String(args.title) : undefined,
                caption: job.caption, mod: job.mod, album: albumId,
                account: mode === "account" ? (creds.accountUsername || "account") : "anonymous",
                uploadedAt: new Date().toISOString()
            };
            ledger.uploads.push(rec);
            results.push({
                file: job.file, ok: true, reused: false, link: rec.link, id: rec.id, deletehash: rec.deletehash,
                width: rec.width, height: rec.height, bytes: rec.bytes, caption: job.caption,
                ...(buf.length > SOFT_SIZE_LIMIT ? { warning: "Over imgur's documented 10 MB API limit — it went through, but downscale if uploads start failing." } : {})
            });
        } catch (e: any) {
            results.push({ file: job.file, ok: false, error: e?.message || String(e) });
        }
    }

    await writeLedger(ledger);

    const ok = results.filter(r => r.ok);
    return okText({
        uploaded: ok.filter(r => !r.reused).length,
        reused: ok.filter(r => r.reused).length,
        failed: results.length - ok.length,
        mode,
        account: mode === "account" ? creds.accountUsername : null,
        ...(albumId ? { album: { id: albumId, created: albumCreated } } : {}),
        results,
        // The whole point: hand this straight to compose_workshop_bbcode.
        bbcodeImages: ok.map(r => ({ url: r.link, ...(r.caption ? { caption: r.caption } : {}) })),
        ...(Object.values(rate).some(Boolean) ? { quotaRemaining: rate } : {}),
        note: "Pass `bbcodeImages` to compose_workshop_bbcode as `images`, then swh_update_description with the result."
    });
}

// ---------------------------------------------------------------------------- imgur_list_uploads / imgur_delete

async function listUploads(args: any) {
    const ledger = await readLedger();
    const modKey = args.mod ? String(args.mod).toLowerCase() : null;
    const albumKey = args.album ? String(args.album).toLowerCase() : null;
    const albumId = albumKey ? (ledger.albums[albumKey]?.id ?? String(args.album)) : null;
    const limit = Number(args.limit) > 0 ? Math.round(Number(args.limit)) : 50;

    const rows = ledger.uploads
        .filter(u => !modKey || String(u.mod || "").toLowerCase() === modKey)
        .filter(u => !albumId || u.album === albumId)
        .slice()
        .reverse()
        .slice(0, limit);

    return okText({
        count: rows.length, total: ledger.uploads.length, ledger: ledgerPath(),
        albums: Object.values(ledger.albums), uploads: rows
    });
}

async function deleteImage(args: any) {
    const ref = String(args.ref || "").trim();
    if (!ref) return errText("'ref' is required — a deletehash, imgur id, or i.imgur.com link.");

    const ledger = await readLedger();
    const idFromLink = ref.match(/i\.imgur\.com\/([A-Za-z0-9]+)/)?.[1];
    const needle = (idFromLink || ref).toLowerCase();
    const idx = ledger.uploads.findIndex(u =>
        u.deletehash?.toLowerCase() === needle || u.id?.toLowerCase() === needle || u.link?.toLowerCase() === ref.toLowerCase()
    );
    const rec = idx >= 0 ? ledger.uploads[idx] : null;

    // Anonymous uploads can ONLY be deleted by deletehash; without a ledger hit there's nothing to try.
    const handle = rec?.deletehash || (idFromLink ? null : ref);
    if (!handle) {
        return errText(`Not in the local ledger and no deletehash given, so there's nothing to delete with. Run imgur_list_uploads to find it (deletehash is the only handle on an anonymous upload).`);
    }

    try {
        const { header } = await authorize(false);
        await imgurCall(`/3/image/${encodeURIComponent(handle)}`, { method: "DELETE", header });
    } catch (e: any) {
        return errText(`imgur refused the delete: ${e?.message || e}`);
    }

    if (idx >= 0) { ledger.uploads.splice(idx, 1); await writeLedger(ledger); }
    return okText({
        ok: true, deleted: rec ? { id: rec.id, link: rec.link, source: rec.source } : { handle },
        ledgerRemaining: ledger.uploads.length,
        note: "Gone from imgur. Any Workshop description still embedding that URL now shows a broken image."
    });
}

// ---------------------------------------------------------------------------- helpers

function mask(v: string): string { return v.length <= 8 ? `${v.slice(0, 3)}…` : `${v.slice(0, 6)}…${v.slice(-2)}`; }
function okText(obj: any) { return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] }; }
function errText(msg: string) { return { content: [{ type: "text" as const, text: msg }] }; }
