const { handleTestingTool } = require('./build/tools/testing');

async function main() {
    const action = process.argv[2];
    const payload = JSON.parse(process.argv[3] || '{}');
    console.log(`Executing ${action} with args:`, payload);
    try {
        const res = await handleTestingTool(action, payload, null, null);
        console.log("SUCCESS:", res.content[0].text);
    } catch (err) {
        console.error("ERROR:", err);
        process.exit(1);
    }
}

main();
