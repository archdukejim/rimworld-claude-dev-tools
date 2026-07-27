const { handleTestingTool } = require('./build/tools/testing');

async function main() {
    try {
        const res = await handleTestingTool("restart_game", { quicktest: true }, null, null);
        console.log("SUCCESS:", res.content[0].text);
    } catch (err) {
        console.error("ERROR:", err);
        process.exit(1);
    }
}

main();
