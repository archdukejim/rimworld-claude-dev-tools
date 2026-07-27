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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureScreen = captureScreen;
exports.captureRegion = captureRegion;
exports.getScreenSize = getScreenSize;
const nut_js_1 = require("@nut-tree-fork/nut-js");
const sharp_1 = __importDefault(require("sharp"));
const types_1 = require("./types");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
let screenshotCounter = 0;
const MAX_SCREENSHOTS = 20;
/**
 * Captures the entire screen and returns the image as a base64 string
 * @param format - The format for the image data (png or jpeg)
 * @param quality - JPEG quality (1-100, optional, defaults to 80)
 * @returns Base64 encoded image data with filename context
 */
async function captureScreen(format = types_1.CaptureFormat.PNG, quality = 80) {
    let tempFilepath = "";
    let finalFilepath = "";
    try {
        screenshotCounter = (screenshotCounter % MAX_SCREENSHOTS) + 1;
        const finalFilename = `screenshot_${String(screenshotCounter).padStart(2, '0')}.${format}`;
        finalFilepath = path.resolve(finalFilename);
        const tempFilename = `temp_screenshot_${(0, crypto_1.randomBytes)(8).toString('hex')}.png`;
        tempFilepath = path.resolve(tempFilename);
        const width = await nut_js_1.screen.width();
        const height = await nut_js_1.screen.height();
        const fullScreenRegion = new nut_js_1.Region(0, 0, width, height);
        console.error(`Attempting to capture screen to temporary file: ${tempFilepath}`);
        await nut_js_1.screen.captureRegion(tempFilepath, fullScreenRegion);
        console.error(`Screen capture command executed for: ${tempFilepath}`);
        try {
            await fs.access(tempFilepath);
            console.error(`Temporary file found: ${tempFilepath}`);
        }
        catch (accessError) {
            console.error(`Temporary file NOT found after capture attempt: ${tempFilepath}`);
            throw new Error(`nut-js failed to create the temporary screenshot file at ${tempFilepath}`);
        }
        let imageBuffer;
        let resultMessage;
        if (format === types_1.CaptureFormat.JPEG) {
            imageBuffer = await (0, sharp_1.default)(tempFilepath)
                .jpeg({ quality: Math.max(1, Math.min(100, quality)) })
                .toBuffer();
            await fs.writeFile(finalFilepath, imageBuffer);
            resultMessage = `File saved as ${finalFilename} (JPEG quality: ${quality}). Image data: data:image/jpeg;base64,`;
        }
        else {
            imageBuffer = await fs.readFile(tempFilepath);
            await fs.writeFile(finalFilepath, imageBuffer);
            resultMessage = `File saved as ${finalFilename}. Image data: data:image/png;base64,`;
        }
        const base64Image = imageBuffer.toString("base64");
        await fs.unlink(tempFilepath);
        return `${resultMessage}${base64Image}`;
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
 * Captures a region of the screen and returns the image as a base64 string
 * @param region - The region to capture (left, top, width, height)
 * @param format - The format for the image data (png or jpeg)
 * @param quality - JPEG quality (1-100, optional, defaults to 80)
 * @returns Base64 encoded image data with filename context
 */
async function captureRegion(region, format = types_1.CaptureFormat.PNG, quality = 80) {
    let tempFilepath = "";
    let finalFilepath = "";
    try {
        screenshotCounter = (screenshotCounter % MAX_SCREENSHOTS) + 1;
        const finalFilename = `screenshot_${String(screenshotCounter).padStart(2, '0')}.${format}`;
        finalFilepath = path.resolve(finalFilename);
        const tempFilename = `temp_screenshot_${(0, crypto_1.randomBytes)(8).toString('hex')}.png`;
        tempFilepath = path.resolve(tempFilename);
        const nutRegion = new nut_js_1.Region(region.left, region.top, region.width, region.height);
        console.error(`Attempting to capture region to temporary file: ${tempFilepath}`);
        await nut_js_1.screen.captureRegion(tempFilepath, nutRegion);
        console.error(`Region capture command executed for: ${tempFilepath}`);
        try {
            await fs.access(tempFilepath);
            console.error(`Temporary file found: ${tempFilepath}`);
        }
        catch (accessError) {
            console.error(`Temporary file NOT found after capture attempt: ${tempFilepath}`);
            throw new Error(`nut-js failed to create the temporary screenshot file at ${tempFilepath}`);
        }
        let imageBuffer;
        let resultMessage;
        if (format === types_1.CaptureFormat.JPEG) {
            imageBuffer = await (0, sharp_1.default)(tempFilepath)
                .jpeg({ quality: Math.max(1, Math.min(100, quality)) })
                .toBuffer();
            await fs.writeFile(finalFilepath, imageBuffer);
            resultMessage = `File saved as ${finalFilename} (JPEG quality: ${quality}). Image data: data:image/jpeg;base64,`;
        }
        else {
            imageBuffer = await fs.readFile(tempFilepath);
            await fs.writeFile(finalFilepath, imageBuffer);
            resultMessage = `File saved as ${finalFilename}. Image data: data:image/png;base64,`;
        }
        const base64Image = imageBuffer.toString("base64");
        await fs.unlink(tempFilepath);
        return `${resultMessage}${base64Image}`;
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
    const width = await nut_js_1.screen.width();
    const height = await nut_js_1.screen.height();
    return {
        width,
        height
    };
}
