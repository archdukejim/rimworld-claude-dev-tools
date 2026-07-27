"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getClipboardText = getClipboardText;
exports.setClipboardText = setClipboardText;
exports.copySelectedText = copySelectedText;
exports.pasteClipboardText = pasteClipboardText;
exports.pasteText = pasteText;
exports.getClipboardImage = getClipboardImage;
const child_process_1 = require("child_process");
const nut_js_1 = require("@nut-tree-fork/nut-js");
const keyboard_1 = require("./keyboard");
/**
 * Gets text from the clipboard
 * @returns The text content from the clipboard
 */
async function getClipboardText() {
    try {
        return await nut_js_1.clipboard.getContent();
    }
    catch (error) {
        console.error("Error getting clipboard text:", error);
        throw new Error("Failed to get clipboard text");
    }
}
/**
 * Sets text to the clipboard
 * @param text - The text to set to the clipboard
 */
async function setClipboardText(text) {
    try {
        await nut_js_1.clipboard.setContent(text);
    }
    catch (error) {
        console.error("Error setting clipboard text:", error);
        throw new Error("Failed to set clipboard text");
    }
}
/**
 * Copies selected text to clipboard using keyboard shortcut
 * then returns the clipboard content
 * @returns The text that was copied to the clipboard
 */
async function copySelectedText() {
    try {
        await (0, keyboard_1.copyToClipboard)();
        await new Promise(resolve => setTimeout(resolve, 100));
        return await getClipboardText();
    }
    catch (error) {
        console.error("Error copying selected text:", error);
        throw new Error("Failed to copy selected text");
    }
}
/**
 * Pastes text from clipboard using keyboard shortcut
 */
async function pasteClipboardText() {
    try {
        await (0, keyboard_1.pasteFromClipboard)();
    }
    catch (error) {
        console.error("Error pasting clipboard text:", error);
        throw new Error("Failed to paste clipboard text");
    }
}
/**
 * Sets text to clipboard then pastes it at current cursor position
 * @param text - The text to paste
 */
async function pasteText(text) {
    try {
        await setClipboardText(text);
        await new Promise(resolve => setTimeout(resolve, 100));
        await pasteClipboardText();
    }
    catch (error) {
        console.error("Error pasting text:", error);
        throw new Error("Failed to paste text");
    }
}
/**
 * Gets the image from the clipboard (if available) as a base64 string
 * @returns Base64 image data or empty string if no image
 */
async function getClipboardImage() {
    return new Promise((resolve, reject) => {
        // PowerShell script to retrieve clipboard image and output as base64.
        const psCommand = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { $image = [System.Windows.Forms.Clipboard]::GetImage(); $ms = New-Object System.IO.MemoryStream; $image.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bytes = $ms.ToArray(); [System.Convert]::ToBase64String($bytes); } else { "" }`;
        (0, child_process_1.exec)(`powershell -NoProfile -Command "${psCommand}"`, (error, stdout, stderr) => {
            if (error) {
                console.error("PowerShell getClipboardImage error:", stderr || error.message);
                reject(new Error(`Failed to retrieve clipboard image: ${stderr || error.message}`));
            }
            else {
                resolve(stdout.trim());
            }
        });
    });
}
