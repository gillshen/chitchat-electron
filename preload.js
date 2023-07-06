const { ipcRenderer } = require("electron");
const marked = require("marked");

window.addEventListener("DOMContentLoaded", () => {
  // ask main.js for a list of chats
  ipcRenderer.send("saved-chats-request");

  // new chat button
  const newChatButton = document.getElementById("new-chat-button");
  newChatButton.addEventListener("click", startNewChat);

  // send button
  const textarea = document.getElementById("input-textarea");
  const sendButton = document.getElementById("send-button");

  sendButton.addEventListener("click", sendPrompt);

  // user input keydown event listener (Enter key)
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      if (event.ctrlKey || event.shiftKey) {
        // insert a newline on ctrl+return or shift+return
        // always effective
        document.execCommand("insertLineBreak");
      } else {
        // send the prompt on a bare return
        // effective only when no API request is in progress
        sendPrompt();
      }
      event.preventDefault();
    }
  });

  // collapsible sidebar toggle
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const toggleIcon = document.getElementById("sidebar-toggle-icon");

  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    if (toggleIcon.classList.toggle("collapsed")) {
      toggleIcon.setAttribute("src", "assets/chevron-right.svg");
    } else {
      toggleIcon.setAttribute("src", "assets/chevron-left.svg");
    }
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

const savedChats = new Map(); // id -> Chat

// a variable to hold the active Chat instance;
// null when a new chat (unsaved) is active
let activeChat = null;

let activeResponseBox = null;
let activeAvatar = null;
let activePrompt = "";

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
    return this._history.map(({ prompt, completionContent }) => ({
      prompt,
      completionContent,
    }));
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

  for (const { prompt, completionContent } of historyArray) {
    const { messageBox: promptBox } = createMessageRow("prompt");
    promptBox.innerHTML = mdToHtml(prompt);
    const { messageBox: responseBox } = createMessageRow("response");
    responseBox.innerHTML = mdToHtml(completionContent);
    responseBox.scrollIntoView();
  }
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
    sendIcon.setAttribute("src", "assets/send-disabled.svg");
    sendButton.classList.add("disabled");
    newChatButton.classList.add("disabled");
    chatList.classList.add("disabled");
  } else {
    sendIcon.setAttribute("src", "assets/send.svg");
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

  // send the prompt to the main process
  ipcRenderer.send("api-request", {
    chatId: activeChat?.id ?? null,
    model: "gpt-3.5-turbo", // TODO get from user input
    prompt,
    context: activeChat?.contextArray() ?? [],
    parameters: {}, // TODO get from user input
  });

  // create the prompt container
  const { messageBox: promptBox } = createMessageRow("prompt");
  promptBox.innerHTML = mdToHtml(prompt);

  // clear the input area
  textarea.innerHTML = "";

  // display the loading gif
  const loadingIcon = document.createElement("img");
  loadingIcon.setAttribute("id", "loading-icon");
  loadingIcon.setAttribute("src", "assets/loading-dots.gif");

  const { avatar, messageBox: responseBox } = createMessageRow("response");
  responseBox.appendChild(loadingIcon);
  responseBox.scrollIntoView({ behavior: "smooth", block: "end" });

  activeResponseBox = responseBox;
  activeAvatar = avatar;
  activePrompt = prompt;
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
    createChatButton(chat.id, chat.title);
  }
});

const createChatButton = (chatId, chatTitle) => {
  const chatList = document.getElementById("chat-list");

  const chatButton = document.createElement("button");
  chatButton.setAttribute("id", `chat-${chatId}`);
  chatButton.setAttribute("class", "chat-button");
  chatList.appendChild(chatButton);

  const chatButtonIcon = document.createElement("img");
  chatButtonIcon.setAttribute("src", "assets/speech-bubble.png");
  chatButtonIcon.classList.add("chat-button-icon");
  chatButton.appendChild(chatButtonIcon);

  const chatButtonText = document.createElement("div");
  chatButtonText.classList.add("chat-button-text");
  chatButtonText.innerText = chatTitle;
  chatButton.appendChild(chatButtonText);

  const chatEditButton = document.createElement("button");
  chatEditButton.classList.add("chat-edit-button");
  chatButton.appendChild(chatEditButton);

  const chatEditIcon = document.createElement("img");
  chatEditIcon.classList.add("chat-edit-icon");
  chatEditIcon.setAttribute("src", "assets/edit-chat.png");
  chatEditButton.appendChild(chatEditIcon);

  const chatDeleteButton = document.createElement("button");
  chatDeleteButton.classList.add("chat-delete-button");
  chatButton.appendChild(chatDeleteButton);

  const chatDeleteIcon = document.createElement("img");
  chatDeleteIcon.classList.add("chat-delete-icon");
  chatDeleteIcon.setAttribute("src", "assets/delete-chat.png");
  chatDeleteButton.appendChild(chatDeleteIcon);

  chatButton.addEventListener("click", () => {
    // disable chat selection while an API request is in progress
    if (requestInProgress) return;

    for (const button of chatList.children) {
      if (button !== chatButton) {
        button.classList.remove("selected");
      }
    }
    chatButton.classList.add("selected");
    const selectedChat = savedChats.get(chatId);
    if (activeChat !== selectedChat) {
      activeChat = selectedChat;
      loadHistory(selectedChat.historyArray());
      showTokenCount();
    }
  });

  chatEditButton.addEventListener("mouseenter", () => {
    chatEditIcon.setAttribute("src", "assets/edit-chat-hover.png");
  });
  chatEditButton.addEventListener("mouseleave", () => {
    chatEditIcon.setAttribute("src", "assets/edit-chat.png");
  });
  chatEditButton.addEventListener("click", (event) => {
    // TODO
    console.log(">>> editing", chatId, chatTitle);
    event.stopPropagation();
  });

  chatDeleteButton.addEventListener("mouseenter", () => {
    chatDeleteIcon.setAttribute("src", "assets/delete-chat-hover.png");
  });
  chatDeleteButton.addEventListener("mouseleave", () => {
    chatDeleteIcon.setAttribute("src", "assets/delete-chat.png");
  });
  chatDeleteButton.addEventListener("click", (event) => {
    // TODO
    console.log(">>> deleting", chatId, chatTitle);
    event.stopPropagation();
  });

  return chatButton;
};

ipcRenderer.on("response-ready", () => {
  setRequestInProgress(false);
  document.getElementById("loading-icon")?.remove();
});

ipcRenderer.on("chat-created", (_, { chatId, chatTitle, systemMessage }) => {
  activeChat = new Chat(chatId, chatTitle, systemMessage);
  savedChats.set(chatId, activeChat);

  // update sidebar
  createChatButton(chatId, chatTitle);
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
    activeResponseBox.innerHTML = mdToHtml(completionContent);
    activeResponseBox.scrollIntoView();

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

    // move the related chat button to the top (if it's not there)
    const chatList = document.getElementById("chat-list");
    const chatButton = document.getElementById(`chat-${chatId}`);
    chatList.insertBefore(chatButton, chatList.firstChild);

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
  activeAvatar.setAttribute("src", "assets/chat-error.svg");
  activeResponseBox.classList.remove("response");
  activeResponseBox.classList.add("error");
  activeResponseBox.innerHTML = error.message;
  document.getElementById("input-textarea").innerText = activePrompt;
});

const createMessageRow = (messageType) => {
  // messageType: "prompt" | "response" | "error"
  const messageRow = document.createElement("div");
  messageRow.classList.add("message-row", `${messageType}-row`);
  document.getElementById("chat-box").appendChild(messageRow);

  const avatar = document.createElement("img");
  avatar.classList.add("avatar");
  if (messageType === "prompt") {
    avatar.setAttribute("src", "assets/chat-prompt.png");
  } else {
    avatar.setAttribute("src", `assets/chat-${messageType}.svg`);
  }
  messageRow.appendChild(avatar);

  const messageBox = document.createElement("div");
  messageBox.classList.add("message", messageType);
  messageRow.appendChild(messageBox);

  return { messageRow, avatar, messageBox };
};

const mdToHtml = (md) => {
  const sanitized = md
    // removing zero-width characters, per marked.js documentation
    .replace(/^[\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, "")
    // perserving single newlines
    .replace(/(?<=\S)[ \t]*\n(?=\S)/gm, "  \n");

  return marked.parse(sanitized, { headerIds: false, mangle: false });
};
