"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.moveMouse = moveMouse;
exports.getMousePosition = getMousePosition;
exports.clickMouse = clickMouse;
exports.clickMouseAt = clickMouseAt;
exports.doubleClick = doubleClick;
exports.doubleClickAt = doubleClickAt;
exports.scrollMouse = scrollMouse;
exports.dragMouse = dragMouse;
exports.dragMouseFromTo = dragMouseFromTo;
const nut_js_1 = require("@nut-tree-fork/nut-js");
const types_1 = require("./types");
/**
 * Moves the mouse to the specified coordinates
 * @param position - The position to move the mouse to (x, y coordinates)
 */
async function moveMouse(position) {
    try {
        const screenWidth = await nut_js_1.screen.width();
        const screenHeight = await nut_js_1.screen.height();
        if (position.x < 0 || position.x > screenWidth || position.y < 0 || position.y > screenHeight) {
            throw new Error(`Coordinates out of bounds. Screen size is ${screenWidth}x${screenHeight}`);
        }
        await nut_js_1.mouse.move([position]);
    }
    catch (error) {
        console.error("Error moving mouse:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to move mouse");
    }
}
/**
 * Gets the current mouse position
 * @returns The current mouse position (x, y coordinates)
 */
async function getMousePosition() {
    try {
        const position = await nut_js_1.mouse.getPosition();
        return {
            x: position.x,
            y: position.y
        };
    }
    catch (error) {
        console.error("Error getting mouse position:", error);
        throw new Error("Failed to get mouse position");
    }
}
/**
 * Clicks the mouse at the current position
 * @param button - The mouse button to click (left, middle, right)
 */
async function clickMouse(button = types_1.MouseButton.LEFT) {
    try {
        if (button === types_1.MouseButton.LEFT) {
            await nut_js_1.mouse.leftClick();
        }
        else if (button === types_1.MouseButton.MIDDLE) {
            await nut_js_1.mouse.click(nut_js_1.Button.MIDDLE);
        }
        else if (button === types_1.MouseButton.RIGHT) {
            await nut_js_1.mouse.rightClick();
        }
        else {
            throw new Error("Invalid mouse button");
        }
    }
    catch (error) {
        console.error("Error clicking mouse:", error);
        throw new Error("Failed to click mouse");
    }
}
/**
 * Clicks the mouse at the specified position
 * @param position - The position to click at (x, y coordinates)
 * @param button - The mouse button to click (left, middle, right)
 */
async function clickMouseAt(position, button = types_1.MouseButton.LEFT) {
    try {
        await moveMouse(position);
        await clickMouse(button);
    }
    catch (error) {
        console.error("Error clicking mouse at position:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to click mouse at position");
    }
}
/**
 * Double-clicks the mouse at the current position
 */
async function doubleClick() {
    try {
        await nut_js_1.mouse.doubleClick(nut_js_1.Button.LEFT);
    }
    catch (error) {
        console.error("Error double-clicking mouse:", error);
        throw new Error("Failed to double-click mouse");
    }
}
/**
 * Double-clicks the mouse at the specified position
 * @param position - The position to double-click at (x, y coordinates)
 */
async function doubleClickAt(position) {
    try {
        await moveMouse(position);
        await doubleClick();
    }
    catch (error) {
        console.error("Error double-clicking mouse at position:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to double-click mouse at position");
    }
}
/**
 * Scroll the mouse wheel
 * @param direction - The direction to scroll (up or down)
 * @param amount - The amount to scroll (number of clicks)
 */
async function scrollMouse(direction, amount = 1) {
    try {
        if (direction === types_1.ScrollDirection.UP) {
            await nut_js_1.mouse.scrollUp(amount);
        }
        else if (direction === types_1.ScrollDirection.DOWN) {
            await nut_js_1.mouse.scrollDown(amount);
        }
        else {
            throw new Error("Invalid scroll direction");
        }
    }
    catch (error) {
        console.error("Error scrolling mouse:", error);
        throw new Error("Failed to scroll mouse");
    }
}
/**
 * Drags the mouse from current position to the specified position
 * @param target - The target position to drag to
 */
async function dragMouse(target) {
    try {
        await nut_js_1.mouse.pressButton(nut_js_1.Button.LEFT);
        await moveMouse(target);
        await nut_js_1.mouse.releaseButton(nut_js_1.Button.LEFT);
    }
    catch (error) {
        try {
            await nut_js_1.mouse.releaseButton(nut_js_1.Button.LEFT);
        }
        catch (releaseError) {
            // Ignore
        }
        console.error("Error dragging mouse:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to drag mouse");
    }
}
/**
 * Drags the mouse from the start position to the end position
 * @param start - The start position to drag from
 * @param end - The end position to drag to
 */
async function dragMouseFromTo(start, end) {
    try {
        await moveMouse(start);
        await nut_js_1.mouse.pressButton(nut_js_1.Button.LEFT);
        await moveMouse(end);
        await nut_js_1.mouse.releaseButton(nut_js_1.Button.LEFT);
    }
    catch (error) {
        try {
            await nut_js_1.mouse.releaseButton(nut_js_1.Button.LEFT);
        }
        catch (releaseError) {
            // Ignore
        }
        console.error("Error dragging mouse:", error);
        throw new Error(error instanceof Error ? error.message : "Failed to drag mouse");
    }
}
