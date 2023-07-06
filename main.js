const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const { Configuration, OpenAIApi } = require("openai");
const sqlite3 = require("sqlite3");

// Set up the chat history database
const db = new sqlite3.Database("chat_history.sqlite");

db.serialize(() => {
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS Chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'New Chat',
      system_message TEXT DEFAULT ''
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS Request (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      created INTEGER NOT NULL,
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

  db.run(`
    CREATE VIEW IF NOT EXISTS MessageListView AS
    SELECT
      Chat.id AS chat_id, 
      Chat.title AS chat_title, 
      Chat.system_message, 
      Request.id AS request_id,
      Request.model,
      Request.created AS completion_created,
      Request.parameters,
      Request.finish_reason,
      Prompt.content AS prompt,
      Completion.content AS completion,
      Prompt.tokens AS prompt_tokens,
	    Completion.tokens AS completion_tokens
    FROM Chat
      LEFT JOIN Request ON Chat.id = Request.chat_id
      LEFT JOIN (SELECT request_id, content, tokens FROM Message WHERE role == 'user') AS Prompt
        ON Request.id = Prompt.request_id
      LEFT JOIN (SELECT request_id, content, tokens FROM Message WHERE role == 'assistant') AS Completion
        ON Request.id = Completion.request_id
    ORDER BY request_id;
  `);
});

// Set up for API requests
const settings = JSON.parse(fs.readFileSync("api_settings.json", "utf-8"));
const configuration = new Configuration({ apiKey: settings.key });
const openai = new OpenAIApi(configuration);

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1150,
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

  // remove the menu bar
  Menu.setApplicationMenu(null);

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

ipcMain.on("saved-chats-request", async (event) => {
  db.all("SELECT * FROM MessageListView", [], function (error, rows) {
    if (error) {
      event.sender.send("saved-chats-retrieval-failure", error);
    } else {
      event.sender.send("saved-chats-ready", rows);
    }
  });
});

ipcMain.on(
  "api-request",
  async (
    event,
    {
      chatId = null,
      chatTitle = "New Chat",
      systemMessage = "",
      model,
      prompt,
      context,
      parameters,
    }
  ) => {
    const params = { model, messages: [...context], ...parameters };
    params.messages.push({ role: "user", content: prompt });

    try {
      const chatCompletion = await openai.createChatCompletion({ ...params });
      event.sender.send("response-ready");

      // save to database
      const timestamp = chatCompletion.data.created;
      const completionContent = chatCompletion.data.choices[0].message.content;
      const finishReason = chatCompletion.data.choices[0].finish_reason;
      const promptTokens = chatCompletion.data.usage.prompt_tokens;
      const completionTokens = chatCompletion.data.usage.completion_tokens;

      if (chatId === null) {
        try {
          chatId = await execInsert(
            "INSERT INTO Chat (title, system_message) VALUES (?, ?)",
            [chatTitle, systemMessage]
          );
          event.sender.send("chat-created", {
            chatId,
            chatTitle,
            systemMessage,
          });
        } catch (error) {
          throw error;
        }
      }

      const requestId = await saveCompletion(
        chatId,
        model,
        timestamp,
        parameters,
        finishReason,
        prompt,
        completionContent,
        promptTokens,
        completionTokens
      );

      // render response
      event.sender.send("response-success", {
        chatId,
        requestId,
        model,
        timestamp,
        parameters,
        finishReason,
        prompt,
        completionContent,
        promptTokens,
        completionTokens,
      });
    } catch (error) {
      event.sender.send("response-ready");
      event.sender.send("response-error", error);
    }
  }
);

const saveCompletion = async (
  chatId,
  model,
  timestamp,
  parameters,
  finishReason,
  prompt,
  completionContent,
  promptTokens,
  completionTokens
) => {
  let requestId;
  const jsonParams = JSON.stringify(parameters, null, "");
  try {
    requestId = await execInsert(
      "INSERT INTO Request (chat_id, model, created, parameters, finish_reason) VALUES (?, ?, ?, ?, ?)",
      [chatId, model, timestamp, jsonParams, finishReason]
    );
  } catch (error) {
    throw error;
  }

  db.serialize(() => {
    saveMessage(requestId, "user", prompt, promptTokens);
    saveMessage(requestId, "assistant", completionContent, completionTokens);
  });

  return requestId;
};

const execInsert = (query, params) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (error) {
      if (error) {
        reject(error);
      } else {
        resolve(this.lastID);
      }
    });
  });
};

const saveMessage = (requestId, role, content, tokens) => {
  db.run(
    "INSERT INTO Message (request_id, role, content, tokens) VALUES (?, ?, ?, ?)",
    [requestId, role, content, tokens]
  );
};
