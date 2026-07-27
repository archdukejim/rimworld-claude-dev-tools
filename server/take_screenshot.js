const { captureScreen } = require('./build/tools/pc/screen');
captureScreen('png', 80).then(res => {
    console.log("Screenshot captured successfully!");
}).catch(err => {
    console.error("Failed to capture screen:", err);
});
