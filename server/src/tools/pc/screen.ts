import { screen, Region as NutRegion } from "@nut-tree-fork/nut-js";
import sharp from "sharp";
import { CaptureFormat, Region as CustomRegion } from "./types";
import * as fs from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";

let screenshotCounter = 0;
const MAX_SCREENSHOTS = 20;

/**
 * Captures the entire screen and returns the image as a base64 string
 * @param format - The format for the image data (png or jpeg)
 * @param quality - JPEG quality (1-100, optional, defaults to 80)
 * @returns Base64 encoded image data with filename context
 */
export async function captureScreen(format: CaptureFormat = CaptureFormat.PNG, quality: number = 80): Promise<string> {
  let tempFilepath = "";
  let finalFilepath = "";
  try {
    screenshotCounter = (screenshotCounter % MAX_SCREENSHOTS) + 1;
    const finalFilename = `screenshot_${String(screenshotCounter).padStart(2, '0')}.${format}`;
    finalFilepath = path.resolve(finalFilename);

    const tempFilename = `temp_screenshot_${randomBytes(8).toString('hex')}.png`;
    tempFilepath = path.resolve(tempFilename);

    const width = await screen.width();
    const height = await screen.height();
    const fullScreenRegion = new NutRegion(0, 0, width, height);

    console.error(`Attempting to capture screen to temporary file: ${tempFilepath}`);
    await screen.captureRegion(tempFilepath, fullScreenRegion);
    console.error(`Screen capture command executed for: ${tempFilepath}`);

    try {
      await fs.access(tempFilepath);
      console.error(`Temporary file found: ${tempFilepath}`);
    } catch (accessError) {
      console.error(`Temporary file NOT found after capture attempt: ${tempFilepath}`);
      throw new Error(`nut-js failed to create the temporary screenshot file at ${tempFilepath}`);
    }

    let imageBuffer: Buffer;
    let resultMessage: string;

    if (format === CaptureFormat.JPEG) {
      imageBuffer = await sharp(tempFilepath)
        .jpeg({ quality: Math.max(1, Math.min(100, quality)) })
        .toBuffer();
      await fs.writeFile(finalFilepath, imageBuffer);
      resultMessage = `File saved as ${finalFilename} (JPEG quality: ${quality}). Image data: data:image/jpeg;base64,`;
    } else {
      imageBuffer = await fs.readFile(tempFilepath);
      await fs.writeFile(finalFilepath, imageBuffer);
      resultMessage = `File saved as ${finalFilename}. Image data: data:image/png;base64,`;
    }

    const base64Image = imageBuffer.toString("base64");
    await fs.unlink(tempFilepath);
    return `${resultMessage}${base64Image}`;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error capturing screen:", error);
    if (tempFilepath) {
      try { await fs.unlink(tempFilepath); } catch (cleanupError) { /* Ignore */ }
    }
    throw new Error(`Failed to capture screen: ${errorMessage}`);
  }
}

/**
 * Captures a region of the screen and returns the image as a base64 string
 * @param region - The region to capture (left, top, width, height)
 * @param format - The format for the image data (png or jpeg)
 * @param quality - JPEG quality (1-100, optional, defaults to 80)
 * @returns Base64 encoded image data with filename context
 */
export async function captureRegion(region: CustomRegion, format: CaptureFormat = CaptureFormat.PNG, quality: number = 80): Promise<string> {
  let tempFilepath = "";
  let finalFilepath = "";
  try {
    screenshotCounter = (screenshotCounter % MAX_SCREENSHOTS) + 1;
    const finalFilename = `screenshot_${String(screenshotCounter).padStart(2, '0')}.${format}`;
    finalFilepath = path.resolve(finalFilename);

    const tempFilename = `temp_screenshot_${randomBytes(8).toString('hex')}.png`;
    tempFilepath = path.resolve(tempFilename);

    const nutRegion = new NutRegion(region.left, region.top, region.width, region.height);
    console.error(`Attempting to capture region to temporary file: ${tempFilepath}`);
    await screen.captureRegion(tempFilepath, nutRegion);
    console.error(`Region capture command executed for: ${tempFilepath}`);

    try {
      await fs.access(tempFilepath);
      console.error(`Temporary file found: ${tempFilepath}`);
    } catch (accessError) {
      console.error(`Temporary file NOT found after capture attempt: ${tempFilepath}`);
      throw new Error(`nut-js failed to create the temporary screenshot file at ${tempFilepath}`);
    }

    let imageBuffer: Buffer;
    let resultMessage: string;

    if (format === CaptureFormat.JPEG) {
      imageBuffer = await sharp(tempFilepath)
        .jpeg({ quality: Math.max(1, Math.min(100, quality)) })
        .toBuffer();
      await fs.writeFile(finalFilepath, imageBuffer);
      resultMessage = `File saved as ${finalFilename} (JPEG quality: ${quality}). Image data: data:image/jpeg;base64,`;
    } else {
      imageBuffer = await fs.readFile(tempFilepath);
      await fs.writeFile(finalFilepath, imageBuffer);
      resultMessage = `File saved as ${finalFilename}. Image data: data:image/png;base64,`;
    }

    const base64Image = imageBuffer.toString("base64");
    await fs.unlink(tempFilepath);
    return `${resultMessage}${base64Image}`;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error capturing region:", error);
    if (tempFilepath) {
      try { await fs.unlink(tempFilepath); } catch (cleanupError) { /* Ignore */ }
    }
    throw new Error(`Failed to capture screen region: ${errorMessage}`);
  }
}

/**
 * Gets the screen dimensions
 * @returns The screen dimensions as width and height
 */
export async function getScreenSize(): Promise<{ width: number; height: number }> {
  const width = await screen.width();
  const height = await screen.height();
  return {
    width,
    height
  };
}
