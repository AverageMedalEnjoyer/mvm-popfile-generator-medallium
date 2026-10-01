const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

/**
 * Where mpc_medallium lives:
 * - Portable Windows EXE (electron-builder): next to the .exe the user double-clicked
 * - Normal packaged app: next to the executable
 * - Dev (`electron .`): project root (folder containing electron.cjs)
 */
function rootDir() {
  // electron-builder portable sets this to the folder containing the portable .exe
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  if (app.isPackaged) {
    return path.dirname(app.getPath("exe"));
  }
  return __dirname;
}

function medalliumDir() {
  return path.join(rootDir(), "mpc_medallium");
}

function savesDir() {
  return path.join(medalliumDir(), "saves");
}

function ensureDirsSync() {
  fs.mkdirSync(medalliumDir(), { recursive: true });
  fs.mkdirSync(savesDir(), { recursive: true });
  return { root: rootDir(), medallium: medalliumDir(), saves: savesDir() };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "MvM Popfile Creator: Medallium",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Works in both asar and unpacked builds when preload.cjs is listed in package.json "files"
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.loadFile(path.join(__dirname, "dist", "index.html"));
  win.setMenuBarVisibility(false);

  win.webContents.on("before-input-event", (event, input) => {
    if (input.control && !input.alt && !input.meta) {
      if (input.key === "=" || input.key === "+") {
        win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
        event.preventDefault();
      } else if (input.key === "-") {
        win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
        event.preventDefault();
      } else if (input.key === "0") {
        win.webContents.setZoomLevel(0);
        event.preventDefault();
      }
    }
  });
}

// ---- mpc_medallium file API ----
ipcMain.handle("mpc:getRoot", async () => rootDir());

ipcMain.handle("mpc:ensureDirs", async () => {
  return ensureDirsSync();
});

ipcMain.handle("mpc:listSaves", async () => {
  ensureDirsSync();
  const dir = savesDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".pop"))
    .sort((a, b) => a.localeCompare(b));
});

ipcMain.handle("mpc:writeSave", async (_e, filename, content) => {
  ensureDirsSync();
  const safe = path.basename(String(filename || "untitled.pop"));
  const full = path.join(savesDir(), safe);
  fs.writeFileSync(full, String(content ?? ""), "utf8");
  return { ok: true, path: full };
});

ipcMain.handle("mpc:readSave", async (_e, filename) => {
  ensureDirsSync();
  const safe = path.basename(String(filename || ""));
  const full = path.join(savesDir(), safe);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
});

app.whenReady().then(() => {
  // Create folders as soon as the app starts (does not depend on the renderer)
  try {
    const dirs = ensureDirsSync();
    console.log("[mpc] root:", dirs.root);
    console.log("[mpc] saves:", dirs.saves);
  } catch (err) {
    console.error("[mpc] failed to create dirs:", err);
  }
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
