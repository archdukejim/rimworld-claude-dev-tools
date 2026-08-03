/**
 * Local text embeddings via Transformers.js (MiniLM, ONNX on CPU) — no external service, ships
 * with the server. Used to give the API search real semantic recall (find the right API even when
 * the query's words don't lexically match RimWorld's naming).
 *
 * @xenova/transformers is ESM-only; the server compiles to CommonJS, so a plain dynamic import()
 * would be downleveled by tsc into require() and fail. This Function wrapper preserves a true
 * runtime import().
 */
const dynamicImport: (m: string) => Promise<any> = new Function("m", "return import(m)") as any;

export const EMBED_DIM = 384;
const MODEL = "Xenova/all-MiniLM-L6-v2";

let extractorPromise: Promise<any> | null = null;
async function getExtractor(): Promise<any> {
    if (!extractorPromise) {
        extractorPromise = (async () => {
            const mod = await dynamicImport("@xenova/transformers");
            return mod.pipeline("feature-extraction", MODEL);
        })();
    }
    return extractorPromise;
}

/** True if the model can be loaded (deps present + model available/cached). */
export async function embeddingsAvailable(): Promise<boolean> {
    try { await getExtractor(); return true; } catch { return false; }
}

/** Embed one string → a normalized 384-d vector (dot product == cosine similarity). */
export async function embed(text: string): Promise<Float32Array> {
    const ex = await getExtractor();
    const out = await ex(text, { pooling: "mean", normalize: true });
    return Float32Array.from(out.data as ArrayLike<number>);
}

/** Embed a batch → one normalized vector per input, in order. */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const ex = await getExtractor();
    const out = await ex(texts, { pooling: "mean", normalize: true });
    const dims = out.dims as number[];
    const dim = dims[dims.length - 1];
    const data = out.data as ArrayLike<number>;
    const vecs: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
        vecs.push(Float32Array.from(Array.prototype.slice.call(data, i * dim, (i + 1) * dim)));
    }
    return vecs;
}

/** Cosine similarity of two normalized vectors (== dot product). */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}
