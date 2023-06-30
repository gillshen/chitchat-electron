const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { Configuration, OpenAIApi } = require("openai");

// Set up for API requests
const settings = JSON.parse(fs.readFileSync("api_settings.json", "utf-8"));
const configuration = new Configuration({ apiKey: settings.key });
const openai = new OpenAIApi(configuration);

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
    },
    // make the window frameless
    // frame: false,
    // titleBarStyle: "hidden",
    // titleBarOverlay: { color: "white", symbolColor: "darkgray" },
    nodeIntegration: true,
  });

  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });

  window.loadFile("index.html");
};

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.on(
  "request",
  async (
    event,
    {
      prompt,
      context,
      temperature,
      top_p,
      presence_penalty,
      frequency_penalty,
      model = "gpt-3.5-turbo",
    }
  ) => {
    const params = { model, messages: [...context] };
    params.messages.push({ role: "user", content: prompt });

    if (!(temperature === undefined)) {
      params.temperature = temperature;
    }
    if (!(top_p === undefined)) {
      params.top_p = top_p;
    }
    if (!(presence_penalty === undefined)) {
      params.presence_penalty = presence_penalty;
    }
    if (!(frequency_penalty === undefined)) {
      params.frequency_penalty = frequency_penalty;
    }

    try {
      const chatCompletion = await openai.createChatCompletion({ ...params });
      event.sender.send("response-ready");

      event.sender.send("response-data", {
        prompt,
        completionData: chatCompletion.data,
      });
    } catch (error) {
      event.sender.send("response-error", error);
    }
  }
);
