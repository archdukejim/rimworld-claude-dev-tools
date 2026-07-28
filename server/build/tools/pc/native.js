"use strict";
/**
 * Lazy access to the native modules the pc-control tools need.
 *
 * nut-js and sharp both ship compiled binaries. Importing them at the top of a module makes them
 * load when `index.js` is first required, which means a machine that cannot load either one takes
 * the whole MCP server down with MODULE_NOT_FOUND before it has spoken a single protocol message -
 * the client just sees an extension that failed to connect, with no indication that the cause was
 * one optional tool family.
 *
 * Resolving them on first use instead keeps that failure local: every other tool still works, and
 * a pc-control call returns an error that says which package is missing and what to do about it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.nut = nut;
exports.sharp = sharp;
exports.nativeToolsAvailable = nativeToolsAvailable;
const NUT_PACKAGE = "@nut-tree-fork/nut-js";
const SHARP_PACKAGE = "sharp";
const cache = new Map();
function describe(pkg, error) {
    return new Error(`The '${pkg}' native module could not be loaded, so this tool is unavailable. ` +
        `Every other RimSynapse MCP tool is unaffected. ` +
        `Reinstall the extension, or run 'npm install' in the server directory if you are running from source. ` +
        `Underlying error: ${error.message}`);
}
function load(pkg) {
    let entry = cache.get(pkg);
    if (!entry) {
        try {
            entry = { module: require(pkg) };
        }
        catch (err) {
            entry = { error: err instanceof Error ? err : new Error(String(err)) };
        }
        cache.set(pkg, entry);
    }
    if (entry.error) {
        throw describe(pkg, entry.error);
    }
    return entry.module;
}
/** The nut-js namespace (mouse, keyboard, screen, clipboard, Button, Key, Region). */
function nut() {
    return load(NUT_PACKAGE);
}
/** The sharp image-processing entry point. */
function sharp() {
    return load(SHARP_PACKAGE);
}
/**
 * Whether both native modules resolve on this machine. Does not throw - use it to report
 * availability rather than to gate a call, since the loaders give a better message on failure.
 */
function nativeToolsAvailable() {
    const missing = [];
    for (const pkg of [NUT_PACKAGE, SHARP_PACKAGE]) {
        try {
            load(pkg);
        }
        catch {
            missing.push(pkg);
        }
    }
    return { available: missing.length === 0, missing };
}
