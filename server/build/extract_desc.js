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
const fs = __importStar(require("fs"));
const mods = [
    { name: "Core", file: "d:\\github\\rimsynapse\\Core\\About\\About.xml" },
    { name: "Conversations", file: "d:\\github\\rimsynapse\\Conversations\\About\\About.xml" },
    { name: "Factions", file: "d:\\github\\rimsynapse\\Factions\\About\\About.xml" },
    { name: "NVIDIA-Tool", file: "d:\\github\\rimsynapse\\NVIDIA-Tool\\About\\About.xml" },
    { name: "Psychology", file: "d:\\github\\rimsynapse\\Psychology\\About\\About.xml" },
    { name: "Regions-and-Territories", file: "d:\\github\\rimsynapse\\Regions-and-Territories\\About\\About.xml" },
    { name: "WorldNews", file: "d:\\github\\rimsynapse\\WorldNews\\About\\About.xml" },
    { name: "AuraAlgorithm", file: "d:\\github\\rimsynapse\\AuraAlgorithm\\About\\About.xml" },
    { name: "LLM-Trainer", file: "d:\\github\\rimsynapse\\LLM-Trainer\\About\\About.xml" }
];
for (const mod of mods) {
    if (fs.existsSync(mod.file)) {
        const content = fs.readFileSync(mod.file, "utf8");
        const match = content.match(/<description>([\s\S]*?)<\/description>/);
        console.log(`\n=== ${mod.name} ===`);
        if (match) {
            console.log(match[1].trim());
        }
        else {
            console.log("No description tag found.");
        }
    }
    else {
        console.log(`\n=== ${mod.name} ===\nFile not found.`);
    }
}
