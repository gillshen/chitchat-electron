const { ipcRenderer } = require("electron");

class Chat {
  constructor(id, name) {
    this._id = id;
    this.name = name;
    this._history = [];
    this._context = [];
  }

  contextArray() {
    // generate an array of messages that can be used in API requests
    const arr = [];
    for (const { prompt, completionData } of this._context) {
      arr.push({ role: "user", content: prompt });
      arr.push({
        role: "assistant",
        content: completionData.choices[0].message.content,
      });
    }
    return arr;
  }

  appendRequest(prompt, completionData) {
    this._history.push({ prompt, completionData });
    this._context.push({ prompt, completionData });
  }

  getContextLength() {
    let sum = 0;
    for (const { completionData } of this._context) {
      sum += completionData.usage.total_tokens;
    }
    return sum;
  }

  trimContext(maximum = 4097, reserve = 410) {
    while (this.getContextLength() + reserve > maximum) {
      return this._context.shift();
    }
  }

  clearContext() {
    this._context = [];
  }
}

const chats = new Map(); // id -> Chat

// TODO to be created dynamically
chats.set(1, new Chat(1, "New Chat"));

const sendPrompt = async () => {
  // Retrieve the prompt as plain text
  const textarea = document.getElementById("input-textarea");
  const prompt = textarea.innerText;

  // Create the prompt container
  const promptBox = createMessageBox("prompt");
  promptBox.innerHTML = prompt; // TODO convert to HTML

  // Clear the input area
  textarea.innerHTML = "";

  // Send the prompt to the main process
  const chat = chats.get(1); // TODO
  chat.trimContext();
  const context = chat.contextArray();
  ipcRenderer.send("request", { prompt, context });

  // Display the loading gif
  const loadingIcon = document.createElement("img");
  loadingIcon.setAttribute("id", "loading-icon");
  loadingIcon.setAttribute("src", "assets/spinner.gif");

  const chatBox = document.getElementById("chat-box");
  chatBox.appendChild(loadingIcon);

  // Scroll to the bottom
  chatBox.scrollTop = chatBox.scrollHeight;
};

window.addEventListener("DOMContentLoaded", () => {
  const textarea = document.getElementById("input-textarea");
  const sendButton = document.getElementById("send-button");

  // Send button click event listener
  sendButton.addEventListener("click", sendPrompt);

  // User input keydown event listener (Enter key)
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      sendPrompt();
      event.preventDefault();
    }
  });
});

ipcRenderer.on("response-ready", () => {
  const loadingIcon = document.getElementById("loading-icon");
  loadingIcon.remove();
});

ipcRenderer.on("response-data", (_, { prompt, completionData }) => {
  const responseBox = createMessageBox("response");

  // TODO convert planitext to HTML
  responseBox.innerHTML = completionData.choices[0].message.content;
  responseBox.scrollIntoView();

  // TODO use actual chat id
  chats.get(1).appendRequest(prompt, completionData);
});

ipcRenderer.on("response-error", (_, error) => {
  const errorBox = createMessageBox("error");
  console.log(error);
  errorBox.innerHTML = error.message;
});

const createMessageBox = (messageType) => {
  const messageRow = document.createElement("div");
  messageRow.classList.add("message-row", `${messageType}-row`);
  document.getElementById("chat-box").appendChild(messageRow);

  const messageBox = document.createElement("div");
  messageBox.classList.add("message", messageType);
  messageRow.appendChild(messageBox);

  return messageBox;
};
