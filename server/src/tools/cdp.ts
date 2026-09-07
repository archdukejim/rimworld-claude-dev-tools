/*
 * Minimal Chrome DevTools Protocol client for driving the RimAgentic Chrome (launch_chrome) over
 * its debugging port — shared by imgur_web_upload and the Steam description update in
 * publish_infographic. In-page CDP evaluation is the sanctioned way to drive websites the agent
 * must stay signed into: no window focus, no blind desktop input, no native dialogs.
 */

export const CDP_PORT_DEFAULT = 9222;

export interface CdpTab { id: string; webSocketDebuggerUrl?: string; }

/** Minimal CDP page session over the built-in WebSocket (Node >= 22). */
export class CdpPage {
    private ws: any; private seq = 0;
    private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
    static async open(wsUrl: string): Promise<CdpPage> {
        const p = new CdpPage();
        p.ws = new WebSocket(wsUrl);
        await new Promise<void>((res, rej) => {
            p.ws.addEventListener("open", () => res());
            p.ws.addEventListener("error", () => rej(new Error("websocket error talking to the tab")));
        });
        p.ws.addEventListener("message", (ev: any) => {
            let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
            const h = m.id && p.pending.get(m.id);
            if (!h) return;
            p.pending.delete(m.id);
            m.error ? h.rej(new Error(m.error.message || JSON.stringify(m.error))) : h.res(m.result);
        });
        return p;
    }
    cmd(method: string, params: any = {}): Promise<any> {
        return new Promise((res, rej) => {
            const id = ++this.seq;
            this.pending.set(id, { res, rej });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression: string): Promise<any> {
        const r = await this.cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r?.exceptionDetails) throw new Error("page JS threw: " + (r.exceptionDetails.exception?.description || "unknown"));
        return r?.result?.value;
    }
    close() { try { this.ws.close(); } catch { /* closing */ } }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Open a new tab at `url` in the RimAgentic Chrome; throws a friendly error when it isn't up. */
export async function openTab(port: number, url: string): Promise<CdpTab> {
    const base = `http://127.0.0.1:${port}`;
    let tab: CdpTab;
    try {
        tab = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json() as CdpTab;
    } catch (e: any) {
        throw new Error(`RimAgentic Chrome is not reachable on port ${port} — run launch_chrome first. (${e?.message || e})`);
    }
    if (!tab?.webSocketDebuggerUrl) throw new Error("Chrome opened no debuggable tab (webSocketDebuggerUrl missing).");
    return tab;
}

/** Best-effort tab cleanup. */
export async function closeTab(port: number, tabId: string): Promise<void> {
    try { await fetch(`http://127.0.0.1:${port}/json/close/${tabId}`); } catch { /* best-effort */ }
}
