import { exec } from "child_process";
import { clipboard } from "@nut-tree-fork/nut-js";
import { copyToClipboard, pasteFromClipboard } from "./keyboard";

/**
 * Gets text from the clipboard
 * @returns The text content from the clipboard
 */
export async function getClipboardText(): Promise<string> {
  try {
    return await clipboard.getContent();
  } catch (error) {
    console.error("Error getting clipboard text:", error);
    throw new Error("Failed to get clipboard text");
  }
}

/**
 * Sets text to the clipboard
 * @param text - The text to set to the clipboard
 */
export async function setClipboardText(text: string): Promise<void> {
  try {
    await clipboard.setContent(text);
  } catch (error) {
    console.error("Error setting clipboard text:", error);
    throw new Error("Failed to set clipboard text");
  }
}

/**
 * Copies selected text to clipboard using keyboard shortcut
 * then returns the clipboard content
 * @returns The text that was copied to the clipboard
 */
export async function copySelectedText(): Promise<string> {
  try {
    await copyToClipboard();
    await new Promise(resolve => setTimeout(resolve, 100));
    return await getClipboardText();
  } catch (error) {
    console.error("Error copying selected text:", error);
    throw new Error("Failed to copy selected text");
  }
}

/**
 * Pastes text from clipboard using keyboard shortcut
 */
export async function pasteClipboardText(): Promise<void> {
  try {
    await pasteFromClipboard();
  } catch (error) {
    console.error("Error pasting clipboard text:", error);
    throw new Error("Failed to paste clipboard text");
  }
}

/**
 * Sets text to clipboard then pastes it at current cursor position
 * @param text - The text to paste
 */
export async function pasteText(text: string): Promise<void> {
  try {
    await setClipboardText(text);
    await new Promise(resolve => setTimeout(resolve, 100));
    await pasteClipboardText();
  } catch (error) {
    console.error("Error pasting text:", error);
    throw new Error("Failed to paste text");
  }
}

/**
 * Gets the image from the clipboard (if available) as a base64 string
 * @returns Base64 image data or empty string if no image
 */
export async function getClipboardImage(): Promise<string> {
  return new Promise((resolve, reject) => {
    // PowerShell script to retrieve clipboard image and output as base64.
    const psCommand = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { $image = [System.Windows.Forms.Clipboard]::GetImage(); $ms = New-Object System.IO.MemoryStream; $image.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bytes = $ms.ToArray(); [System.Convert]::ToBase64String($bytes); } else { "" }`;
    exec(`powershell -NoProfile -Command "${psCommand}"`, (error, stdout, stderr) => {
      if (error) {
        console.error("PowerShell getClipboardImage error:", stderr || error.message);
        reject(new Error(`Failed to retrieve clipboard image: ${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
