const { ipcRenderer } = require("electron");
const marked = require("marked");

window.addEventListener("DOMContentLoaded", () => {
  // ask main.js for a list of chats
  ipcRenderer.send("saved-chats-request");

  // new chat button
  const newChatButton = document.getElementById("new-chat-button");
  newChatButton.addEventListener("click", startNewChat);

  // input area
  const textarea = document.getElementById("input-textarea");
  textarea.contentEditable = "true";

  // send button
  const sendButton = document.getElementById("send-button");

  sendButton.addEventListener("click", sendPrompt);

  // send the prompt upon the user pressing enter
  textarea.addEventListener("keydown", (event) => {
    // insert a newline on ctrl+return or shift+return
    if (event.key !== "Enter" || event.ctrlKey || event.shiftKey) return;

    sendPrompt(); // does nothing when an API request is in progress
    event.preventDefault();
  });

  // remove formatting before pasting into the prompt box
  textarea.addEventListener("paste", pasteAsPlainText);

  // open search window upon the user pressing ctrl+f or cmd+f
  document.addEventListener("keydown", (event) => {
    if (event.key === "f" && (event.ctrlKey || event.metaKey)) {
      ipcRenderer.send("search-window-open-request");
    }
  });

  // collapsible sidebar toggle
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const toggleIcon = document.getElementById("sidebar-toggle-icon");

  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    toggleIcon.src = toggleIcon.classList.toggle("collapsed")
      ? "assets/chevron-right.svg"
      : "assets/chevron-left.svg";
  });

  // resizing
  const resizeHandle = document.getElementById("resize-handle");
  const chatBox = document.getElementById("chat-box");
  const inputBox = document.getElementById("input-box");
  let startMouseY = 0;
  let startMessageHeight = 0;
  let startInputHeight = 0;

  const handleMouseMove = (event) => {
    const deltaY = event.clientY - startMouseY;
    const newMessageHeight = startMessageHeight + deltaY;
    const newInputHeight = startInputHeight - deltaY;

    if (newMessageHeight >= 0 && newInputHeight >= 0) {
      chatBox.style.height = newMessageHeight + "px";
      inputBox.style.height = newInputHeight + "px";
    }
  };

  resizeHandle.addEventListener("mousedown", (event) => {
    startMouseY = event.clientY;
    startMessageHeight = chatBox.offsetHeight;
    startInputHeight = inputBox.offsetHeight;

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", function () {
      document.removeEventListener("mousemove", handleMouseMove);
    });
  });

  // status bar
  showTokenCount();
});

const pasteAsPlainText = (event) => {
  event.preventDefault();

  const clipboardData = event.clipboardData || window.clipboardData;
  const plainText = clipboardData.getData("text/plain");

  const selection = window.getSelection();
  // check if a cursor or an active selection exists
  if (!selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  range.deleteContents();

  const textNode = document.createTextNode(plainText);
  range.insertNode(textNode);

  // move the cursor to the end of the inserted text
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  selection.removeAllRanges();
  selection.addRange(range);
};

const savedChats = new Map(); // id -> Chat

// a variable to hold the active Chat instance;
// null when a new chat (unsaved) is active
let activeChat = null;

let activePromptRow = null;
let activeResponseRow = null;

let requestInProgress = false;

class Chat {
  constructor(id, title = "New Chat", systemMessage = "") {
    this.id = id;
    this.title = title;
    this.systemMessage = systemMessage;

    // two containers of request objects:
    // {
    //   requestId,
    //   model,
    //   parameters,
    //   timestamp,
    //   finishReason,
    //   prompt,
    //   completionContent,
    //   promptTokens,
    //   completionTokens,
    // }
    this._history = [];
    this._context = [];
  }

  updated() {
    if (this._history.length === 0) {
      return Infinity;
    }
    const timestamps = this._history.map((req) => req.timestamp);
    return Math.max(...timestamps);
  }

  historyArray() {
    // generate an array of messages for display in the chat box
    return this._history.map(
      ({ requestId, timestamp, prompt, completionContent }) => ({
        requestId,
        timestamp,
        prompt,
        completionContent,
      })
    );
  }

  contextArray(trim = true) {
    // generate an array of messages for use in API requests
    if (trim) {
      this.trimContext();
    }

    const arr = [{ role: "system", content: this.systemMessage }];

    for (const { prompt, completionContent } of this._context) {
      arr.push({ role: "user", content: prompt });
      arr.push({ role: "assistant", content: completionContent });
    }
    return arr;
  }

  appendRequest(request) {
    this._history.push(request);
    this._context.push(request);
  }

  getContextLength() {
    // TODO count the system message also
    let sum = 0;
    for (const { promptTokens, completionTokens } of this._context) {
      sum += promptTokens + completionTokens;
    }
    return sum;
  }

  trimContext(maximum = 4097, reserve = 410) {
    while (this.getContextLength() + reserve > maximum) {
      this._context.shift();
    }
  }

  clearContext() {
    this._context = [];
  }
}

const loadHistory = (historyArray) => {
  const chatBox = document.getElementById("chat-box");
  chatBox.innerHTML = "";

  for (const { requestId, prompt, completionContent } of historyArray) {
    const promptRow = new PromptRow(prompt);
    promptRow.setElementId(requestId);
    const responseRow = new ResponseRow(completionContent);
    responseRow.setElementId(requestId);
  }
  chatBox.scrollTop = chatBox.scrollHeight;
};

const setRequestInProgress = (flag) => {
  // accepts a boolean
  requestInProgress = flag;

  // if true, disable the sidebar and prompt-sending
  const sendIcon = document.getElementById("send-icon");
  const sendButton = document.getElementById("send-button");
  const newChatButton = document.getElementById("new-chat-button");
  const chatList = document.getElementById("chat-list");

  if (flag) {
    sendIcon.src = "assets/send-disabled.svg";
    sendButton.classList.add("disabled");
    newChatButton.classList.add("disabled");
    chatList.classList.add("disabled");
  } else {
    sendIcon.src = "assets/send.svg";
    sendButton.classList.remove("disabled");
    newChatButton.classList.remove("disabled");
    chatList.classList.remove("disabled");
  }
};

const startNewChat = () => {
  if (requestInProgress) return;

  activeChat = null;
  document.getElementById("chat-box").innerHTML = "";
  const chatList = document.getElementById("chat-list");
  for (const chatButton of chatList.children) {
    chatButton.classList.remove("selected");
  }
  showTokenCount();
};

const sendPrompt = async () => {
  if (requestInProgress) return;

  setRequestInProgress(true);

  // retrieve the prompt as plain text
  const textarea = document.getElementById("input-textarea");
  const prompt = textarea.innerText;

  // create the prompt container
  activePromptRow = new PromptRow(prompt);

  // clear the input area
  textarea.innerHTML = "";

  // show the response box with a loading gif
  activeResponseRow = new ResponseRow();
  activeResponseRow.showLoadingIcon();

  // send the prompt to the main process
  ipcRenderer.send("api-request", {
    chatId: activeChat?.id ?? null,
    model: "gpt-3.5-turbo", // TODO get from user input
    prompt,
    context: activeChat?.contextArray() ?? [],
    parameters: {}, // TODO get from user input
  });

  // scroll to the very bottom
  const chatBox = document.getElementById("chat-box");
  setTimeout(() => (chatBox.scrollTop = chatBox.scrollHeight), 100);
};

ipcRenderer.on("saved-chats-retrieval-failure", (_, error) => {
  throw error; // TODO
});

ipcRenderer.on("saved-chats-ready", (_, rows) => {
  let currentChat = null;

  for (const row of rows) {
    if (savedChats.has(row.chat_id)) {
      currentChat = savedChats.get(row.chat_id);
    } else {
      currentChat = new Chat(row.chat_id, row.chat_title, row.system_message);
      savedChats.set(row.chat_id, currentChat);
    }
    currentChat.appendRequest({
      requestId: row.request_id,
      model: row.model,
      parameters: JSON.parse(row.parameters),
      timestamp: row.completion_created,
      finishReason: row.finish_reason,
      prompt: row.prompt,
      completionContent: row.completion,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
    });
  }

  // list chats in the sidebar, sorted by most-recently-updated
  const sortedChats = Array.from(savedChats.values()).sort(
    (a, b) => b.updated() - a.updated()
  );
  for (const chat of sortedChats) {
    new ChatListItem(chat.id, chat.title);
  }
});

ipcRenderer.on("go-to", (_, { chatId, requestId, messageType }) => {
  const chatListItem = ChatListItem.map.get(chatId);
  chatListItem.select();

  const messageRowId = MessageRow.elementId(requestId, messageType);
  const messageRow = document.getElementById(messageRowId);
  messageRow.scrollIntoView();
});

ipcRenderer.on("response-ready", () => {
  setRequestInProgress(false);
  document.getElementById("loading-icon")?.remove();
});

ipcRenderer.on("chat-created", (_, { chatId, chatTitle, systemMessage }) => {
  // update saved chats map
  activeChat = new Chat(chatId, chatTitle, systemMessage);
  savedChats.set(chatId, activeChat);

  // update sidebar
  const chatListItem = new ChatListItem(chatId, chatTitle);
  chatListItem.moveToTop();
  chatListItem.select();
});

ipcRenderer.on("chat-title-generated", (_, { chatId, chatTitle }) => {
  const chatListItem = ChatListItem.map.get(chatId);
  chatListItem.setText(chatTitle);
});

ipcRenderer.on("chat-title-edit-failure", (_, { chatId, oldTitle }) => {
  const chatListItem = ChatListItem.map.get(chatId);
  chatListItem.setText(oldTitle);
});

ipcRenderer.on("chat-deleted", (_, deletedChatId) => {
  if (savedChats.get(deletedChatId) === activeChat) {
    savedChats.delete(deletedChatId);
    activeChat = null;
    document.getElementById("chat-box").innerHTML = "";
  }
  const chatListItem = ChatListItem.map.get(deletedChatId);
  chatListItem.remove();
});

ipcRenderer.on(
  "response-success",
  (
    _,
    {
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
    }
  ) => {
    // show completion
    activeResponseRow.setMarkdown(completionContent);
    activeResponseRow.scrollIntoView();

    // update prompt and response elements
    activePromptRow.setElementId(requestId);
    activeResponseRow.setElementId(requestId);

    // store request data
    activeChat.appendRequest({
      requestId,
      model,
      parameters,
      timestamp,
      finishReason,
      prompt,
      completionContent,
      promptTokens,
      completionTokens,
    });

    // move the relevant chat button to top (if not there already)
    ChatListItem.map.get(chatId).moveToTop();
    showTokenCount();
  }
);

const showTokenCount = () => {
  const statusBar = document.getElementById("status-bar");
  const tokenCount = activeChat?.getContextLength() ?? 0;
  statusBar.innerText = `${tokenCount} / 4097`;
};

ipcRenderer.on("response-error", (_, error) => {
  console.log(error);
  activeResponseRow.showError(error);
  // restore the prompt to the input area
  document.getElementById("input-textarea").innerText = activePromptRow.text;
});

const mdToHtml = (md) => {
  const sanitized = md
    // removing zero-width characters, per marked.js documentation
    .replace(/^[\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, "")
    // perserving single newlines
    .replace(/(?<=\S)[ \t]*\n(?=\S)/gm, "  \n");

  return marked.parse(sanitized, { headerIds: false, mangle: false });
};

class ChatListItem {
  constructor(chatId, chatTitle) {
    ChatListItem.map.set(chatId, this);
    this.chatId = chatId;

    this.button = document.createElement("button");
    this.button.id = `chat-${chatId}`;
    this.button.classList.add("chat-button");
    this.parent().appendChild(this.button);

    this.icon = document.createElement("img");
    this.icon.src = "assets/speech-bubble.png";
    this.icon.classList.add("chat-button-icon");
    this.button.appendChild(this.icon);

    this.textDiv = document.createElement("div");
    this.textDiv.classList.add("chat-button-text");
    this.textDiv.innerText = chatTitle;
    this.button.appendChild(this.textDiv);

    this.editButton = document.createElement("button");
    this.editButton.classList.add("chat-edit-button");
    this.button.appendChild(this.editButton);

    this.editIcon = document.createElement("img");
    this.editIcon.classList.add("chat-edit-icon");
    this.editIcon.src = "assets/edit-chat.png";
    this.editButton.appendChild(this.editIcon);

    this.deleteButton = document.createElement("button");
    this.deleteButton.classList.add("chat-delete-button");
    this.button.appendChild(this.deleteButton);

    this.deleteIcon = document.createElement("img");
    this.deleteIcon.classList.add("chat-delete-icon");
    this.deleteIcon.src = "assets/delete-chat.png";
    this.deleteButton.appendChild(this.deleteIcon);

    this.button.addEventListener("mouseenter", () => {
      if (this.textDiv.contentEditable !== "true") this._showButtons();
    });
    this.button.addEventListener("mouseleave", () => this._hideButtons());

    this.button.addEventListener("click", () => {
      // selection disabled while an API request is in progress
      if (!requestInProgress) this.select();
    });

    // prevent chat selection if text is being edited
    this.textDiv.addEventListener("click", (event) => {
      if (this.textDiv.contentEditable === "true") event.stopPropagation();
    });
    // prevent releasing the space key from tiggering focusout
    this.textDiv.addEventListener("keyup", (event) => {
      if (event.code === "Space") event.preventDefault();
    });
    // remove formatting before pasting into the text div
    this.textDiv.addEventListener("paste", pasteAsPlainText);

    this.editButton.addEventListener("mouseenter", () => {
      this.editIcon.src = "assets/edit-chat-hover.png";
    });
    this.editButton.addEventListener("mouseleave", () => {
      this.editIcon.src = "assets/edit-chat.png";
    });
    this.editButton.addEventListener("click", (event) => {
      this.editTitle();
      event.stopPropagation();
    });

    this.deleteButton.addEventListener("mouseenter", () => {
      this.deleteIcon.src = "assets/delete-chat-hover.png";
    });
    this.deleteButton.addEventListener("mouseleave", () => {
      this.deleteIcon.src = "assets/delete-chat.png";
    });
    this.deleteButton.addEventListener("click", (event) => {
      this.deleteChat();
      event.stopPropagation();
    });
  }

  _showButtons() {
    this.editButton.classList.add("visible");
    this.deleteButton.classList.add("visible");
  }

  _hideButtons() {
    this.editButton.classList.remove("visible");
    this.deleteButton.classList.remove("visible");
  }

  parent() {
    return document.getElementById("chat-list");
  }

  remove() {
    this.parent().removeChild(this.button);
  }

  select() {
    // update sidebar
    for (const button of this.parent().children) {
      button.classList.remove("selected");
    }
    this.button.classList.add("selected");

    const selectedChat = savedChats.get(this.chatId);

    // if a different chat is selected than the currently active one
    if (activeChat !== selectedChat) {
      activeChat = selectedChat;
      loadHistory(selectedChat.historyArray());
      showTokenCount();
    }
  }

  moveToTop() {
    const chatList = this.parent();
    chatList.insertBefore(this.button, chatList.firstChild);
  }

  setText(text) {
    this.textDiv.innerText = text;
  }

  editTitle() {
    const oldTitle = this.textDiv.innerText;

    this._hideButtons();
    this.textDiv.contentEditable = "true";
    this.textDiv.focus();

    const onKeyDown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendTitleEditRequest();
      }
    };

    const onFocusOut = () => {
      sendTitleEditRequest();
    };

    const onClick = (event) => {
      if (event.target !== this.textDiv) sendTitleEditRequest();
    };

    const sendTitleEditRequest = () => {
      ipcRenderer.send("chat-title-edit-request", {
        chatId: this.chatId,
        oldTitle,
        newTitle: this.textDiv.innerText,
      });
      // clean up and restore
      this.textDiv.contentEditable = "false";
      this.textDiv.removeEventListener("keydown", onKeyDown);
      this.textDiv.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("click", onClick);
    };

    this.textDiv.addEventListener("keydown", onKeyDown);
    this.textDiv.addEventListener("focusout", onFocusOut);
    document.addEventListener("click", onClick);
  }

  deleteChat() {
    ipcRenderer.send("open-chat-delete-dialog", {
      chatId: this.chatId,
      chatTitle: this.textDiv.innerText,
    });
  }
}

ChatListItem.map = new Map(); // chatId -> ChatListItem instance

class MessageRow {
  constructor(messageType, text = "") {
    this.type = messageType;
    this.text = "";

    this.row = document.createElement("div");
    this.row.classList.add("message-row", `${messageType}-row`);
    this.parent().appendChild(this.row);

    this.avatar = document.createElement("img");
    this.avatar.classList.add("avatar");
    this.row.appendChild(this.avatar);

    this.messageBox = document.createElement("div");
    this.messageBox.classList.add("message", messageType);
    this.row.appendChild(this.messageBox);

    this.setMarkdown(text);
  }

  parent() {
    return document.getElementById("chat-box");
  }

  setElementId(requestId) {
    // this.row.id = `${this.type}-row-${requestId}`;
    this.row.id = MessageRow.elementId(requestId, this.type);
  }

  setMarkdown(text) {
    this.text = text;
    this.messageBox.innerHTML = mdToHtml(text);
  }

  scrollIntoView(options) {
    this.row.scrollIntoView(options);
  }
}

class PromptRow extends MessageRow {
  constructor(text = "") {
    super("prompt", text);
    this.avatar.src = "assets/chat-prompt.png";
  }
}

class ResponseRow extends MessageRow {
  constructor(text = "") {
    super("response", text);
    this.avatar.src = "assets/chat-response.svg";
    this.loadingIcon = null;
  }

  showLoadingIcon() {
    this.loadingIcon = document.createElement("img");
    this.loadingIcon.id = "loading-icon";
    this.loadingIcon.src = "assets/loading-dots.gif";
    this.messageBox.appendChild(this.loadingIcon);
  }

  removeLoadingIcon() {
    if (this.loadingIcon !== null) this.loadingIcon.remove();
  }

  showError(error) {
    this.avatar.src = "assets/chat-error.svg";
    this.messageBox.classList.remove("response");
    this.messageBox.classList.add("error");
    this.messageBox.innerHTML = error.message;
  }
}

MessageRow.elementId = (requestId, messageType) => {
  return `${messageType}-row-${requestId}`;
};
