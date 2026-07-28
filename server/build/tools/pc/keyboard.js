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
const native_1 = require("./native");
const types_1 = require("./types");
/**
 * Maps our key enum to nut.js key enum
 * @param key - Key from our Key enum
 * @returns Corresponding nut.js key
 */
function mapToNutKey(key) {
    const { Key: NutKey } = (0, native_1.nut)();
    if (key === types_1.Key.WINDOWS) {
        return NutKey.LeftSuper;
    }
    if (key === types_1.Key.ENTER) {
        return NutKey.Enter;
    }
    return NutKey[key.toUpperCase()];
}
/**
 * Types the specified text
 * @param text - The text to type
 */
async function typeText(text) {
    const { keyboard } = (0, native_1.nut)();
    try {
        await keyboard.type(text);
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
    const { keyboard } = (0, native_1.nut)();
    try {
        const nutKey = mapToNutKey(key);
        if (!nutKey) {
            throw new Error(`Invalid key: ${key}`);
        }
        await keyboard.pressKey(nutKey);
        await keyboard.releaseKey(nutKey);
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
    const { keyboard } = (0, native_1.nut)();
    const nutKeys = keys.map(k => mapToNutKey(k));
    if (nutKeys.some(k => !k)) {
        throw new Error("Invalid key in shortcut");
    }
    try {
        for (const key of nutKeys) {
            await keyboard.pressKey(key);
        }
        for (let i = nutKeys.length - 1; i >= 0; i--) {
            await keyboard.releaseKey(nutKeys[i]);
        }
    }
    catch (error) {
        try {
            for (const key of nutKeys) {
                await keyboard.releaseKey(key);
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
    const { keyboard } = (0, native_1.nut)();
    try {
        const nutKey = mapToNutKey(key);
        if (!nutKey) {
            throw new Error(`Invalid key: ${key}`);
        }
        await keyboard.pressKey(nutKey);
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
    const { keyboard } = (0, native_1.nut)();
    try {
        const nutKey = mapToNutKey(key);
        if (!nutKey) {
            throw new Error(`Invalid key: ${key}`);
        }
        await keyboard.releaseKey(nutKey);
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
    const { keyboard } = (0, native_1.nut)();
    try {
        for (let i = 0; i < text.length; i++) {
            await keyboard.type(text.charAt(i));
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    catch (error) {
        console.error("Error typing text with delay:", error);
        throw new Error("Failed to type text with delay");
    }
}
