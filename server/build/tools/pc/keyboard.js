"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.typeText = typeText;
exports.pressKey = pressKey;
exports.pressKeyShortcut = pressKeyShortcut;
exports.holdKey = holdKey;
exports.releaseKey = releaseKey;
exports.copyToClipboard = copyToClipboard;
exports.pasteFromClipboard = pasteFromClipboard;
exports.typeTextWithDelay = typeTextWithDelay;
const nut_js_1 = require("@nut-tree-fork/nut-js");
const types_1 = require("./types");
/**
 * Maps our key enum to nut.js key enum
 * @param key - Key from our Key enum
 * @returns Corresponding nut.js key
 */
function mapToNutKey(key) {
    if (key === types_1.Key.WINDOWS) {
        return nut_js_1.Key.LeftSuper;
    }
    if (key === types_1.Key.ENTER) {
        return nut_js_1.Key.Enter;
    }
    return nut_js_1.Key[key.toUpperCase()];
}
/**
 * Types the specified text
 * @param text - The text to type
 */
async function typeText(text) {
    try {
        await nut_js_1.keyboard.type(text);
    }
    catch (error) {
        console.error("Error typing text:", error);
        throw new Error("Failed to type text");
    }
}
/**
 * Presses a keyboard key
 * @param key - The key to press
 */
async function pressKey(key) {
    try {
        const nutKey = mapToNutKey(key);
        if (!nutKey) {
            throw new Error(`Invalid key: ${key}`);
        }
        await nut_js_1.keyboard.pressKey(nutKey);
        await nut_js_1.keyboard.releaseKey(nutKey);
    }
    catch (error) {
        console.error("Error pressing key:", error);
        throw new Error(`Failed to press key: ${key}`);
    }
}
/**
 * Presses a keyboard shortcut (combination of keys)
 * @param keys - Array of keys to press simultaneously
 */
async function pressKeyShortcut(keys) {
    if (keys.length === 0) {
        throw new Error("No keys provided for shortcut");
    }
    const nutKeys = keys.map(k => mapToNutKey(k));
    if (nutKeys.some(k => !k)) {
        throw new Error("Invalid key in shortcut");
    }
    try {
        for (const key of nutKeys) {
            await nut_js_1.keyboard.pressKey(key);
        }
        for (let i = nutKeys.length - 1; i >= 0; i--) {
            await nut_js_1.keyboard.releaseKey(nutKeys[i]);
        }
    }
    catch (error) {
        try {
            for (const key of nutKeys) {
                await nut_js_1.keyboard.releaseKey(key);
            }
        }
        catch (releaseError) {
            // Ignore
        }
        console.error("Error pressing key shortcut:", error);
        throw new Error("Failed to press key shortcut");
    }
}
/**
 * Holds down a key
 * @param key - The key to hold down
 */
async function holdKey(key) {
    try {
        const nutKey = mapToNutKey(key);
        if (!nutKey) {
            throw new Error(`Invalid key: ${key}`);
        }
        await nut_js_1.keyboard.pressKey(nutKey);
    }
    catch (error) {
        console.error("Error holding key:", error);
        throw new Error(`Failed to hold key: ${key}`);
    }
}
/**
 * Releases a key that's being held down
 * @param key - The key to release
 */
async function releaseKey(key) {
    try {
        const nutKey = mapToNutKey(key);
        if (!nutKey) {
            throw new Error(`Invalid key: ${key}`);
        }
        await nut_js_1.keyboard.releaseKey(nutKey);
    }
    catch (error) {
        console.error("Error releasing key:", error);
        throw new Error(`Failed to release key: ${key}`);
    }
}
/**
 * Performs a copy operation (Ctrl+C or Command+C)
 */
async function copyToClipboard() {
    try {
        const isMac = process.platform === "darwin";
        if (isMac) {
            await pressKeyShortcut([types_1.Key.COMMAND, types_1.Key.C]);
        }
        else {
            await pressKeyShortcut([types_1.Key.CONTROL, types_1.Key.C]);
        }
    }
    catch (error) {
        console.error("Error copying to clipboard:", error);
        throw new Error("Failed to copy to clipboard");
    }
}
/**
 * Performs a paste operation (Ctrl+V or Command+V)
 */
async function pasteFromClipboard() {
    try {
        const isMac = process.platform === "darwin";
        if (isMac) {
            await pressKeyShortcut([types_1.Key.COMMAND, types_1.Key.V]);
        }
        else {
            await pressKeyShortcut([types_1.Key.CONTROL, types_1.Key.V]);
        }
    }
    catch (error) {
        console.error("Error pasting from clipboard:", error);
        throw new Error("Failed to paste from clipboard");
    }
}
/**
 * Types text with delays between keystrokes
 * @param text - The text to type
 * @param delayMs - Delay between keystrokes in milliseconds
 */
async function typeTextWithDelay(text, delayMs = 100) {
    try {
        for (let i = 0; i < text.length; i++) {
            await nut_js_1.keyboard.type(text.charAt(i));
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    catch (error) {
        console.error("Error typing text with delay:", error);
        throw new Error("Failed to type text with delay");
    }
}
