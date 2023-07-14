const {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  ipcMain,
  shell,
  dialog,
} = require("electron");

const fs = require("fs");
const path = require("path");

const { Configuration, OpenAIApi } = require("openai");
const { encoding_for_model } = require("tiktoken");

const Fuse = require("fuse.js");
const sqlite3 = require("sqlite3");
const { stringify: csvStringify } = require("csv-stringify/sync");

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

const ENCODINGS = new Map();

for (const model of ["gpt-3.5-turbo", "gpt-4"]) {
  ENCODINGS.set(model, encoding_for_model(model));
}

let mainWindow;
let searchWindow;

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
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
  // this also removes the context menu, which shall be rebuilt below
  Menu.setApplicationMenu(null);

  mainWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.webContents.on("context-menu", (_, params) => {
    // rebuild the context menu
    let ctrlOrCmd = process.platform === "darwin" ? "Cmd" : "Ctrl";
    const contextMenu = Menu.buildFromTemplate([
      {
        role: "cut",
        enabled: params.editFlags.canCut,
        accelerator: `${ctrlOrCmd}+X`,
      },
      {
        role: "copy",
        enabled: params.editFlags.canCopy,
        accelerator: `${ctrlOrCmd}+C`,
      },
      {
        role: "paste",
        enabled: params.editFlags.canPaste,
        accelerator: `${ctrlOrCmd}+V`,
      },
      {
        role: "delete",
        enabled: params.editFlags.canDelete,
        accelerator: "Delete",
      },
      { type: "separator" },
      {
        role: "selectall",
        enabled: params.editFlags.canSelectAll,
        accelerator: `${ctrlOrCmd}+A`,
      },
      { type: "separator" },
    ]);

    contextMenu.append(
      new MenuItem({
        label: "Find",
        accelerator: `${ctrlOrCmd}+F`,
        click: showSearchWindow,
      })
    );

    contextMenu.popup();
  });

  // close the search window if the main window is closed
  mainWindow.on("closed", () => {
    searchWindow?.close();
  });

  mainWindow.loadFile("index.html");
};

const createSearchWindow = () => {
  searchWindow = new BrowserWindow({
    width: 600,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "search", "preload.js"),
      sandbox: false,
    },
    nodeIntegration: true,
  });
  searchWindow.on("closed", () => {
    searchWindow = undefined;
  });
  searchWindow.loadFile("search/index.html");
};

const showSearchWindow = () => {
  if (searchWindow === undefined) {
    createSearchWindow();
  } else {
    searchWindow.show();
  }
  searchWindow.webContents.send("reset-focus");
};

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
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

ipcMain.on("search-window-open-request", () => {
  showSearchWindow();
});

ipcMain.on(
  "chat-title-edit-request",
  async (event, { chatId, oldTitle, newTitle }) => {
    db.run(
      "UPDATE Chat SET title = ? WHERE id = ?",
      [newTitle, chatId],
      function (error) {
        if (error) {
          // tell the renderer to restore the old title
          event.sender.send("chat-title-edit-failure", { chatId, oldTitle });
          throw error;
        }
      }
    );
  }
);

ipcMain.on("open-chat-export-dialog", async (_, { chatId, chatTitle }) => {
  // sanitize the chat title
  // for use in the default filename
  const baseName = chatTitle.replace(/[<>:;"/\\|?*\x00-\x1F]/g, "_");

  // timestamp to be appended to the default filename
  const timestamp = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/[:.Z]/g, "");

  const dialogOptions = {
    title: "Export conversation history",
    defaultPath: path.join(__dirname, `${baseName} ${timestamp}`),
    filters: [{ name: "CSV File", extensions: ["csv"] }],
  };
  const { filePath, canceled } = await dialog.showSaveDialog(
    mainWindow,
    dialogOptions
  );
  if (canceled) return;

  // if a file path is provided
  try {
    const rows = await execSelect(
      `
    SELECT 
      model,
      system_message,
      prompt,
      parameters,
      completion,
      completion_created,
      finish_reason
    FROM MessageListView 
      WHERE chat_id = ?`,
      [chatId]
    );
    // convert utc time to iso datetime format
    const dateConvertedRows = rows.map((row) => {
      const convertedDate = new Date(row.completion_created * 1000);
      return { ...row, completion_created: convertedDate.toISOString() };
    });

    const csv = csvStringify(dateConvertedRows, { header: true });
    fs.writeFileSync(filePath, csv);

    dialog.showMessageBoxSync(mainWindow, {
      type: "info",
      message: "Export successful",
    });
  } catch (error) {
    if (error) {
      dialog.showErrorBox("Export failed", error.toString());
    }
  }
});

ipcMain.on("open-chat-delete-dialog", async (event, { chatId, chatTitle }) => {
  const dialogOptions = {
    type: "question",
    buttons: ["Confirm", "Cancel"],
    defaultId: 0,
    title: "Confirm deletion",
    message: `Are you sure you want to delete ${chatTitle}?`,
    detail:
      "The history of this conversation will be deleted from the database. This action cannot be undone.",
  };

  const { response } = await dialog.showMessageBox(mainWindow, dialogOptions);
  if (response !== 0) {
    return;
  }

  // if user confirms deletion
  db.run("DELETE FROM Chat WHERE id = ?", [chatId], function (error) {
    if (error) {
      throw error;
    } else {
      event.sender.send("chat-deleted", chatId);
    }
  });
});

ipcMain.on("search-initiated", async (_, query) => {
  const messagePool = await execSelect(`
    SELECT
      chat_id AS chatId,
      chat_title AS chatTitle,
      request_id AS requestId,
      completion_created AS timestamp,
      prompt,
      completion AS completionContent
    FROM MessageListView
  `);

  let minMatchLength;
  if (query.length <= 4) {
    minMatchLength = query.length;
  } else if (query.length === 5) {
    minMatchLength = query.length - 1;
  } else if (query.length <= 7) {
    minMatchLength = query.length - 2;
  } else if (query.length <= 9) {
    minMatchLength = query.length - 3;
  } else {
    minMatchLength = query.length - 4;
  }

  const fuseOptions = {
    isCaseSensitive: false,
    includeScore: false,
    shouldSort: true,
    includeMatches: true,
    findAllMatches: true,
    minMatchCharLength: Math.max(minMatchLength, 2),
    threshold: 0.05,
    ignoreLocation: true,
    // location: 0,
    // distance: 100,
    // useExtendedSearch: false,
    // ignoreFieldNorm: false,
    // fieldNormWeight: 1,
    keys: ["prompt", "completionContent"],
  };

  const fuse = new Fuse(messagePool, fuseOptions);
  const fuseResults = fuse.search(query);

  const results = fuseResults.map(({ item, matches }) => ({
    chatId: item.chatId,
    chatTitle: item.chatTitle,
    requestId: item.requestId,
    timestamp: item.timestamp,
    matches,
  }));

  // in case the search window was destroyed between
  // sending the query and receiving the results
  if (searchWindow === undefined) {
    createSearchWindow();
  } else {
    searchWindow.show();
  }
  searchWindow.webContents.send("search-results-ready", results);
});

ipcMain.on("go-to", (_, { chatId, requestId, messageType }) => {
  mainWindow.webContents.send("go-to", { chatId, requestId, messageType });
  mainWindow.show();
});

ipcMain.on(
  "api-request",
  async (
    event,
    {
      chatId = null,
      chatTitle = "",
      systemMessage = "",
      model,
      prompt,
      context,
      parameters,
    }
  ) => {
    const originalChatId = chatId;
    const params = { model, messages: [...context], ...parameters };
    params.messages.push({ role: "user", content: prompt });

    try {
      const chatCompletion = await openai.createChatCompletion(params);

      const timestamp = chatCompletion.data.created;
      const completionContent = chatCompletion.data.choices[0].message.content;
      const finishReason = chatCompletion.data.choices[0].finish_reason;
      const promptTokens = countTokens(model, prompt);
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
      event.sender.send("response-ready");

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

      // if a title-less new chat, generate a title for it
      if (originalChatId === null && !chatTitle) {
        event.sender.send("generating-chat-title", { chatId });

        const titlePrompt =
          "Consider the following dialog.\n\n" +
          "<blockquote>\n" +
          `Q: ${prompt}\n\n` +
          `A: ${completionContent}\n\n` +
          "</blockquote>\n\n" +
          "Please assign a title to this dialog. " +
          "The title should be in the language of the question " +
          "and fit in the width of roughly 30 latin characters. " +
          "Reply with the title only.";

        const params = {
          model,
          messages: [{ role: "user", content: titlePrompt }],
        };
        const titleResponse = await openai.createChatCompletion(params);
        const newTitle = titleResponse.data.choices[0].message.content;

        // update database
        db.run("UPDATE Chat set title = ? WHERE id = ?", [newTitle, chatId]);

        // report to the renderer
        event.sender.send("chat-title-generated", {
          chatId,
          chatTitle: newTitle,
        });
      }
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

const countTokens = (model, text) => {
  const encoding = ENCODINGS.get(model);
  return encoding.encode(text).length;
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

const execSelect = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(query, params, (error, rows) => {
      if (error) {
        reject(error);
      } else {
        resolve(rows);
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
