"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureScreen = captureScreen;
exports.captureRegion = captureRegion;
exports.getScreenSize = getScreenSize;
const native_1 = require("./native");
const types_1 = require("./types");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
let screenshotCounter = 0;
const MAX_SCREENSHOTS = 20;
/**
 * Captures the entire screen, writes it to a PNG/JPEG file, and returns the file PATH.
 *
 * It used to append the whole image as a base64 data URI to the return string. That routinely
 * blew the tool-output token limit, so every screenshot then had to be dumped to a file and
 * decoded via PowerShell before it could be read — 2-3 extra calls per capture. The file is
 * already on disk here; returning its path lets the caller Read it directly (the Read tool
 * renders images), which is one call and no base64 in the transcript.
 *
 * @param format - The format for the image data (png or jpeg)
 * @param quality - JPEG quality (1-100, optional, defaults to 80)
 * @returns The absolute path of the saved image file
 */
async function captureScreen(format = types_1.CaptureFormat.PNG, quality = 80) {
    const { screen, Region: NutRegion } = (0, native_1.nut)();
    let tempFilepath = "";
    let finalFilepath = "";
    try {
        screenshotCounter = (screenshotCounter % MAX_SCREENSHOTS) + 1;
        const finalFilename = `screenshot_${String(screenshotCounter).padStart(2, '0')}.${format}`;
        finalFilepath = path.resolve(finalFilename);
        const tempFilename = `temp_screenshot_${(0, crypto_1.randomBytes)(8).toString('hex')}.png`;
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
        }
        catch (accessError) {
            console.error(`Temporary file NOT found after capture attempt: ${tempFilepath}`);
            throw new Error(`nut-js failed to create the temporary screenshot file at ${tempFilepath}`);
        }
        if (format === types_1.CaptureFormat.JPEG) {
            // sharp is only needed to re-encode as JPEG, so the PNG path below still works on a
            // machine where sharp will not load.
            const imageBuffer = await (0, native_1.sharp)()(tempFilepath)
                .jpeg({ quality: Math.max(1, Math.min(100, quality)) })
                .toBuffer();
            await fs.writeFile(finalFilepath, imageBuffer);
        }
        else {
            await fs.copyFile(tempFilepath, finalFilepath);
        }
        await fs.unlink(tempFilepath);
        return finalFilepath;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Error capturing screen:", error);
        if (tempFilepath) {
            try {
                await fs.unlink(tempFilepath);
            }
            catch (cleanupError) { /* Ignore */ }
        }
        throw new Error(`Failed to capture screen: ${errorMessage}`);
    }
}
/**
 * Captures a region of the screen, writes it to a PNG/JPEG file, and returns the file PATH.
 * See captureScreen for why this returns a path instead of inline base64.
 *
 * @param region - The region to capture (left, top, width, height)
 * @param format - The format for the image data (png or jpeg)
 * @param quality - JPEG quality (1-100, optional, defaults to 80)
 * @returns The absolute path of the saved image file
 */
async function captureRegion(region, format = types_1.CaptureFormat.PNG, quality = 80) {
    const { screen, Region: NutRegion } = (0, native_1.nut)();
    let tempFilepath = "";
    let finalFilepath = "";
    try {
        screenshotCounter = (screenshotCounter % MAX_SCREENSHOTS) + 1;
        const finalFilename = `screenshot_${String(screenshotCounter).padStart(2, '0')}.${format}`;
        finalFilepath = path.resolve(finalFilename);
        const tempFilename = `temp_screenshot_${(0, crypto_1.randomBytes)(8).toString('hex')}.png`;
        tempFilepath = path.resolve(tempFilename);
        const nutRegion = new NutRegion(region.left, region.top, region.width, region.height);
        console.error(`Attempting to capture region to temporary file: ${tempFilepath}`);
        await screen.captureRegion(tempFilepath, nutRegion);
        console.error(`Region capture command executed for: ${tempFilepath}`);
        try {
            await fs.access(tempFilepath);
            console.error(`Temporary file found: ${tempFilepath}`);
        }
        catch (accessError) {
            console.error(`Temporary file NOT found after capture attempt: ${tempFilepath}`);
            throw new Error(`nut-js failed to create the temporary screenshot file at ${tempFilepath}`);
        }
        if (format === types_1.CaptureFormat.JPEG) {
            // sharp is only needed to re-encode as JPEG, so the PNG path below still works on a
            // machine where sharp will not load.
            const imageBuffer = await (0, native_1.sharp)()(tempFilepath)
                .jpeg({ quality: Math.max(1, Math.min(100, quality)) })
                .toBuffer();
            await fs.writeFile(finalFilepath, imageBuffer);
        }
        else {
            await fs.copyFile(tempFilepath, finalFilepath);
        }
        await fs.unlink(tempFilepath);
        return finalFilepath;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Error capturing region:", error);
        if (tempFilepath) {
            try {
                await fs.unlink(tempFilepath);
            }
            catch (cleanupError) { /* Ignore */ }
        }
        throw new Error(`Failed to capture screen region: ${errorMessage}`);
    }
}
/**
 * Gets the screen dimensions
 * @returns The screen dimensions as width and height
 */
async function getScreenSize() {
    const { screen } = (0, native_1.nut)();
    const width = await screen.width();
    const height = await screen.height();
    return {
        width,
        height
    };
}
