import { keyboard, Key as NutKey } from "@nut-tree-fork/nut-js";
import { Key } from "./types";

/**
 * Maps our key enum to nut.js key enum
 * @param key - Key from our Key enum
 * @returns Corresponding nut.js key
 */
function mapToNutKey(key: Key): any {
  if (key === Key.WINDOWS) {
    return NutKey.LeftSuper;
  }
  if (key === Key.ENTER) {
    return NutKey.Enter;
  }
  return (NutKey as any)[key.toUpperCase()];
}

/**
 * Types the specified text
 * @param text - The text to type
 */
export async function typeText(text: string): Promise<void> {
  try {
    await keyboard.type(text);
  } catch (error) {
    console.error("Error typing text:", error);
    throw new Error("Failed to type text");
  }
}

/**
 * Presses a keyboard key
 * @param key - The key to press
 */
export async function pressKey(key: Key): Promise<void> {
  try {
    const nutKey = mapToNutKey(key);
    if (!nutKey) {
      throw new Error(`Invalid key: ${key}`);
    }
    await keyboard.pressKey(nutKey);
    await keyboard.releaseKey(nutKey);
  } catch (error) {
    console.error("Error pressing key:", error);
    throw new Error(`Failed to press key: ${key}`);
  }
}

/**
 * Presses a keyboard shortcut (combination of keys)
 * @param keys - Array of keys to press simultaneously
 */
export async function pressKeyShortcut(keys: Key[]): Promise<void> {
  if (keys.length === 0) {
    throw new Error("No keys provided for shortcut");
  }
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
  } catch (error) {
    try {
      for (const key of nutKeys) {
        await keyboard.releaseKey(key);
      }
    } catch (releaseError) {
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
export async function holdKey(key: Key): Promise<void> {
  try {
    const nutKey = mapToNutKey(key);
    if (!nutKey) {
      throw new Error(`Invalid key: ${key}`);
    }
    await keyboard.pressKey(nutKey);
  } catch (error) {
    console.error("Error holding key:", error);
    throw new Error(`Failed to hold key: ${key}`);
  }
}

/**
 * Releases a key that's being held down
 * @param key - The key to release
 */
export async function releaseKey(key: Key): Promise<void> {
  try {
    const nutKey = mapToNutKey(key);
    if (!nutKey) {
      throw new Error(`Invalid key: ${key}`);
    }
    await keyboard.releaseKey(nutKey);
  } catch (error) {
    console.error("Error releasing key:", error);
    throw new Error(`Failed to release key: ${key}`);
  }
}

/**
 * Performs a copy operation (Ctrl+C or Command+C)
 */
export async function copyToClipboard(): Promise<void> {
  try {
    const isMac = process.platform === "darwin";
    if (isMac) {
      await pressKeyShortcut([Key.COMMAND, Key.C]);
    } else {
      await pressKeyShortcut([Key.CONTROL, Key.C]);
    }
  } catch (error) {
    console.error("Error copying to clipboard:", error);
    throw new Error("Failed to copy to clipboard");
  }
}

/**
 * Performs a paste operation (Ctrl+V or Command+V)
 */
export async function pasteFromClipboard(): Promise<void> {
  try {
    const isMac = process.platform === "darwin";
    if (isMac) {
      await pressKeyShortcut([Key.COMMAND, Key.V]);
    } else {
      await pressKeyShortcut([Key.CONTROL, Key.V]);
    }
  } catch (error) {
    console.error("Error pasting from clipboard:", error);
    throw new Error("Failed to paste from clipboard");
  }
}

/**
 * Types text with delays between keystrokes
 * @param text - The text to type
 * @param delayMs - Delay between keystrokes in milliseconds
 */
export async function typeTextWithDelay(text: string, delayMs: number = 100): Promise<void> {
  try {
    for (let i = 0; i < text.length; i++) {
      await keyboard.type(text.charAt(i));
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  } catch (error) {
    console.error("Error typing text with delay:", error);
    throw new Error("Failed to type text with delay");
  }
}
