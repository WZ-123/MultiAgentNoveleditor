const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

function registerIpc() {
  ipcMain.handle('mana-chat-completions', async (event, { url, headers, body }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Chat Completions ${res.status}: ${text}`)
    }
    return JSON.parse(text)
  })
}

function createWindow () {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  })

  // In development, load from localhost
  // In production, load from the dist folder
  const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;
  
  if (isDev) {
    // Wait slightly for Vite to start
    setTimeout(() => {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    }, 1000);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  // 打开开发工具
  // mainWindow.webContents.openDevTools()
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})
