import { mouse, screen, Button } from "@nut-tree-fork/nut-js";
import { MouseButton, Point, ScrollDirection } from "./types";

/**
 * Moves the mouse to the specified coordinates
 * @param position - The position to move the mouse to (x, y coordinates)
 */
export async function moveMouse(position: Point): Promise<void> {
  try {
    const screenWidth = await screen.width();
    const screenHeight = await screen.height();
    if (position.x < 0 || position.x > screenWidth || position.y < 0 || position.y > screenHeight) {
      throw new Error(`Coordinates out of bounds. Screen size is ${screenWidth}x${screenHeight}`);
    }
    await mouse.move([position]);
  } catch (error) {
    console.error("Error moving mouse:", error);
    throw new Error(error instanceof Error ? error.message : "Failed to move mouse");
  }
}

/**
 * Gets the current mouse position
 * @returns The current mouse position (x, y coordinates)
 */
export async function getMousePosition(): Promise<Point> {
  try {
    const position = await mouse.getPosition();
    return {
      x: position.x,
      y: position.y
    };
  } catch (error) {
    console.error("Error getting mouse position:", error);
    throw new Error("Failed to get mouse position");
  }
}

/**
 * Clicks the mouse at the current position
 * @param button - The mouse button to click (left, middle, right)
 */
export async function clickMouse(button: MouseButton = MouseButton.LEFT): Promise<void> {
  try {
    if (button === MouseButton.LEFT) {
      await mouse.leftClick();
    } else if (button === MouseButton.MIDDLE) {
      await mouse.click(Button.MIDDLE);
    } else if (button === MouseButton.RIGHT) {
      await mouse.rightClick();
    } else {
      throw new Error("Invalid mouse button");
    }
  } catch (error) {
    console.error("Error clicking mouse:", error);
    throw new Error("Failed to click mouse");
  }
}

/**
 * Clicks the mouse at the specified position
 * @param position - The position to click at (x, y coordinates)
 * @param button - The mouse button to click (left, middle, right)
 */
export async function clickMouseAt(position: Point, button: MouseButton = MouseButton.LEFT): Promise<void> {
  try {
    await moveMouse(position);
    await clickMouse(button);
  } catch (error) {
    console.error("Error clicking mouse at position:", error);
    throw new Error(error instanceof Error ? error.message : "Failed to click mouse at position");
  }
}

/**
 * Double-clicks the mouse at the current position
 */
export async function doubleClick(): Promise<void> {
  try {
    await mouse.doubleClick(Button.LEFT);
  } catch (error) {
    console.error("Error double-clicking mouse:", error);
    throw new Error("Failed to double-click mouse");
  }
}

/**
 * Double-clicks the mouse at the specified position
 * @param position - The position to double-click at (x, y coordinates)
 */
export async function doubleClickAt(position: Point): Promise<void> {
  try {
    await moveMouse(position);
    await doubleClick();
  } catch (error) {
    console.error("Error double-clicking mouse at position:", error);
    throw new Error(error instanceof Error ? error.message : "Failed to double-click mouse at position");
  }
}

/**
 * Scroll the mouse wheel
 * @param direction - The direction to scroll (up or down)
 * @param amount - The amount to scroll (number of clicks)
 */
export async function scrollMouse(direction: ScrollDirection, amount: number = 1): Promise<void> {
  try {
    if (direction === ScrollDirection.UP) {
      await mouse.scrollUp(amount);
    } else if (direction === ScrollDirection.DOWN) {
      await mouse.scrollDown(amount);
    } else {
      throw new Error("Invalid scroll direction");
    }
  } catch (error) {
    console.error("Error scrolling mouse:", error);
    throw new Error("Failed to scroll mouse");
  }
}

/**
 * Drags the mouse from current position to the specified position
 * @param target - The target position to drag to
 */
export async function dragMouse(target: Point): Promise<void> {
  try {
    await mouse.pressButton(Button.LEFT);
    await moveMouse(target);
    await mouse.releaseButton(Button.LEFT);
  } catch (error) {
    try {
      await mouse.releaseButton(Button.LEFT);
    } catch (releaseError) {
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
export async function dragMouseFromTo(start: Point, end: Point): Promise<void> {
  try {
    await moveMouse(start);
    await mouse.pressButton(Button.LEFT);
    await moveMouse(end);
    await mouse.releaseButton(Button.LEFT);
  } catch (error) {
    try {
      await mouse.releaseButton(Button.LEFT);
    } catch (releaseError) {
      // Ignore
    }
    console.error("Error dragging mouse:", error);
    throw new Error(error instanceof Error ? error.message : "Failed to drag mouse");
  }
}
