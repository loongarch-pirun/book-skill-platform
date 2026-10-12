const { app } = require("electron");
const fs = require("fs");
app.whenReady().then(() => {
  fs.writeFileSync(__dirname + "/../abi.txt", "ELECTRON_ABI=" + process.versions.modules + " ELECTRON=" + process.versions.electron);
  app.quit();
});
