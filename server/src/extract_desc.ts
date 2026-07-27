import * as fs from "fs";
import * as path from "path";

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
        } else {
            console.log("No description tag found.");
        }
    } else {
        console.log(`\n=== ${mod.name} ===\nFile not found.`);
    }
}
