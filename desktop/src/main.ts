import { app, BrowserWindow } from "electron";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadURL("about:blank");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});
