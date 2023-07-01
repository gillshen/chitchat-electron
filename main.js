const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const { Configuration, OpenAIApi } = require("openai");
const sqlite3 = require("sqlite3");

// Set up the chat history database
const db = new sqlite3.Database("chatlog.sqlite");
db.serialize(() => {
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS Chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      system_message TEXT DEFAULT '',
      date_started TEXT DEFAULT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS Request (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      parameters TEXT DEFAULT NULL, -- json field
      finish_reason TEXT DEFAULT NULL,
      FOREIGN KEY (chat_id) REFERENCES Chat(id) ON UPDATE CASCADE ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS Message (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens INTEGER DEFAULT NULL,
      FOREIGN KEY (request_id) REFERENCES Request(id) ON UPDATE CASCADE ON DELETE CASCADE
    );
  `);
});

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
  async (event, { chatId, model, prompt, context, parameters }) => {
    const params = { model, messages: [...context], ...parameters };
    params.messages.push({ role: "user", content: prompt });

    try {
      const chatCompletion = await openai.createChatCompletion({ ...params });
      event.sender.send("response-ready");

      // save to database
      const timestamp = chatCompletion.data.created * 1000;
      const completionContent = chatCompletion.data.choices[0].message.content;
      const finishReason = chatCompletion.data.choices[0].finish_reason;
      const promptTokens = chatCompletion.data.usage.prompt_tokens;
      const completionTokens = chatCompletion.data.usage.completion_tokens;
      let requestId;

      db.serialize(() => {
        // TODO handle chat creation
        db.run(
          "INSERT OR IGNORE INTO Chat (id, title, system_message, date_started) VALUES (?, ?, ?, ?)",
          chatId,
          "New Chat",
          "",
          timestamp
        );
        db.run(
          "INSERT INTO Request (chat_id, model, timestamp, parameters, finish_reason) VALUES (?, ?, ?, ?, ?)",
          chatId,
          model,
          timestamp,
          JSON.stringify(parameters, null, ""),
          finishReason,
          function (error) {
            if (error) {
              throw error;
            } else {
              requestId = this.lastID;
              saveMessages(
                requestId,
                prompt,
                completionContent,
                promptTokens,
                completionTokens
              );
            }
          }
        );
      });

      event.sender.send("response-success", {
        requestId,
        timestamp,
        prompt,
        completionContent,
        finishReason,
        promptTokens,
        completionTokens,
      });
    } catch (error) {
      event.sender.send("response-error", error);
    }
  }
);

const saveMessages = (
  requestId,
  prompt,
  completionContent,
  promptTokens,
  completionTokens
) => {
  db.serialize(() => {
    saveMessage(requestId, "user", prompt, promptTokens);
    saveMessage(requestId, "assistant", completionContent, completionTokens);
  });
};

const saveMessage = (requestId, role, content, tokens) => {
  db.run(
    "INSERT INTO Message (request_id, role, content, tokens) VALUES (?, ?, ?, ?)",
    requestId,
    role,
    content,
    tokens
  );
};
