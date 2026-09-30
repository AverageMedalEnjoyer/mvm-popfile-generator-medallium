const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "MvM Popfile Creator: Medallium",
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  win.setMenuBarVisibility(false);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.control && !input.alt && !input.meta) {
      if (input.key === '=' || input.key === '+') {
        win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
        event.preventDefault();
      } else if (input.key === '-') {
        win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
        event.preventDefault();
      } else if (input.key === '0') {
        win.webContents.setZoomLevel(0);
        event.preventDefault();
      }
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
