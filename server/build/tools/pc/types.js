"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CaptureFormat = exports.ScrollDirection = exports.Key = exports.MouseButton = void 0;
/**
 * Types for mouse buttons
 */
var MouseButton;
(function (MouseButton) {
    MouseButton["LEFT"] = "left";
    MouseButton["MIDDLE"] = "middle";
    MouseButton["RIGHT"] = "right";
})(MouseButton || (exports.MouseButton = MouseButton = {}));
/**
 * Common keyboard keys enum
 */
var Key;
(function (Key) {
    // Basic keys
    Key["BACKSPACE"] = "backspace";
    Key["TAB"] = "tab";
    Key["ENTER"] = "enter";
    Key["SHIFT"] = "shift";
    Key["CONTROL"] = "control";
    Key["ALT"] = "alt";
    Key["PAUSE"] = "pause";
    Key["CAPSLOCK"] = "capslock";
    Key["ESCAPE"] = "escape";
    Key["SPACE"] = "space";
    Key["PAGEUP"] = "pageup";
    Key["PAGEDOWN"] = "pagedown";
    Key["END"] = "end";
    Key["HOME"] = "home";
    Key["LEFTARROW"] = "left";
    Key["UPARROW"] = "up";
    Key["RIGHTARROW"] = "right";
    Key["DOWNARROW"] = "down";
    Key["INSERT"] = "insert";
    Key["DELETE"] = "delete";
    // Numbers
    Key["NUM0"] = "0";
    Key["NUM1"] = "1";
    Key["NUM2"] = "2";
    Key["NUM3"] = "3";
    Key["NUM4"] = "4";
    Key["NUM5"] = "5";
    Key["NUM6"] = "6";
    Key["NUM7"] = "7";
    Key["NUM8"] = "8";
    Key["NUM9"] = "9";
    // Letters
    Key["A"] = "a";
    Key["B"] = "b";
    Key["C"] = "c";
    Key["D"] = "d";
    Key["E"] = "e";
    Key["F"] = "f";
    Key["G"] = "g";
    Key["H"] = "h";
    Key["I"] = "i";
    Key["J"] = "j";
    Key["K"] = "k";
    Key["L"] = "l";
    Key["M"] = "m";
    Key["N"] = "n";
    Key["O"] = "o";
    Key["P"] = "p";
    Key["Q"] = "q";
    Key["R"] = "r";
    Key["S"] = "s";
    Key["T"] = "t";
    Key["U"] = "u";
    Key["V"] = "v";
    Key["W"] = "w";
    Key["X"] = "x";
    Key["Y"] = "y";
    Key["Z"] = "z";
    // Function keys
    Key["F1"] = "f1";
    Key["F2"] = "f2";
    Key["F3"] = "f3";
    Key["F4"] = "f4";
    Key["F5"] = "f5";
    Key["F6"] = "f6";
    Key["F7"] = "f7";
    Key["F8"] = "f8";
    Key["F9"] = "f9";
    Key["F10"] = "f10";
    Key["F11"] = "f11";
    Key["F12"] = "f12";
    // Numpad
    Key["NUMPAD0"] = "numpad0";
    Key["NUMPAD1"] = "numpad1";
    Key["NUMPAD2"] = "numpad2";
    Key["NUMPAD3"] = "numpad3";
    Key["NUMPAD4"] = "numpad4";
    Key["NUMPAD5"] = "numpad5";
    Key["NUMPAD6"] = "numpad6";
    Key["NUMPAD7"] = "numpad7";
    Key["NUMPAD8"] = "numpad8";
    Key["NUMPAD9"] = "numpad9";
    Key["NUMPADMULTIPLY"] = "numpadmultiply";
    Key["NUMPADADD"] = "numpadadd";
    Key["NUMPADSUBTRACT"] = "numpadsubtract";
    Key["NUMPADDECIMAL"] = "numpaddecimal";
    Key["NUMPADDIVIDE"] = "numpaddivide";
    // Other keys
    Key["COMMAND"] = "command";
    Key["WINDOWS"] = "windows";
    Key["PRINTSCREEN"] = "printscreen";
})(Key || (exports.Key = Key = {}));
/**
 * Direction for scrolling
 */
var ScrollDirection;
(function (ScrollDirection) {
    ScrollDirection["UP"] = "up";
    ScrollDirection["DOWN"] = "down";
})(ScrollDirection || (exports.ScrollDirection = ScrollDirection = {}));
/**
 * Screen capture format
 */
var CaptureFormat;
(function (CaptureFormat) {
    CaptureFormat["PNG"] = "png";
    CaptureFormat["JPEG"] = "jpeg";
})(CaptureFormat || (exports.CaptureFormat = CaptureFormat = {}));
