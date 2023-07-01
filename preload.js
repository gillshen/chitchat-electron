const { ipcRenderer } = require("electron");
const marked = require("marked");

class Chat {
  constructor(id, name) {
    this._id = id;
    this.name = name;

    // two containers of request objects:
    // {
    //   requestId,
    //   timestamp,
    //   prompt,
    //   completionContent,
    //   finishReason,
    //   promptTokens,
    //   completionTokens,
    // }
    this._history = [];
    this._context = [];
  }

  contextArray() {
    // generate an array of messages that can be used in API requests
    const arr = [];
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
    let sum = 0;
    for (const { promptTokens, completionTokens } of this._context) {
      sum += promptTokens + completionTokens;
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
  promptBox.innerHTML = mdToHtml(prompt);

  // Clear the input area
  textarea.innerHTML = "";

  // Send the prompt to the main process
  const chat = chats.get(1); // TODO
  chat.trimContext();
  const context = chat.contextArray();

  ipcRenderer.send("request", {
    chatId: 1, // TODO
    model: "gpt-3.5-turbo", // TODO get from user input
    prompt,
    context,
    parameters: {}, // TODO get from user input
  });

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
      if (event.ctrlKey || event.shiftKey) {
        // insert a newline on ctrl+return or shift+return
        document.execCommand("insertLineBreak");
      } else {
        sendPrompt(); // send the prompt on a bare return
      }
      event.preventDefault();
    }
    // if (event.key === "Enter" && event.ctrlKey) {
    //   sendPrompt();
    //   event.preventDefault();
    // }
  });
});

ipcRenderer.on("response-ready", () => {
  const loadingIcon = document.getElementById("loading-icon");
  loadingIcon.remove();
});

ipcRenderer.on(
  "response-success",
  (
    _,
    {
      requestId,
      timestamp,
      prompt,
      completionContent,
      finishReason,
      promptTokens,
      completionTokens,
    }
  ) => {
    const responseBox = createMessageBox("response");

    // TODO convert planitext to HTML
    responseBox.innerHTML = mdToHtml(completionContent);
    responseBox.scrollIntoView();

    // TODO use actual chat id
    chats.get(1).appendRequest({
      requestId,
      timestamp,
      prompt,
      completionContent,
      finishReason,
      promptTokens,
      completionTokens,
    });
  }
);

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

const mdToHtml = (md) => {
  // for removing zero-width characters, per marked.js documentation
  const unsafe = /^[\u200B\u200C\u200D\u200E\u200F\uFEFF]/g;

  // for perserving single newlines
  const loneNewline = /(?<=\S)[ \t]*\n(?=\S)/gm;

  return marked.parse(md.replace(unsafe, "").replace(loneNewline, "  \n"));
};
