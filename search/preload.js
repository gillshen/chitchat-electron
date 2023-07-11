const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  // search box
  const searchBox = document.getElementById("search-textarea");

  searchBox.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const query = searchBox.innerText;
      if (query.length > 1) {
        ipcRenderer.send("search-initiated", query);
      }
    }
  });

  searchBox.addEventListener("paste", pasteAsPlainText);
});

// TODO duplicate code from ../preload.js
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

ipcRenderer.on("reset-focus", (_) => {
  const searchBox = document.getElementById("search-textarea");
  searchBox.focus();
});

ipcRenderer.on("search-results-ready", (_, results) => {
  const resultList = document.getElementById("result-list");
  resultList.innerHTML = "";

  if (results.length === 0) {
    resultList.innerHTML = "No matches found";
    return;
  }

  for (const { chatId, chatTitle, requestId, matches } of results) {
    for (const { key, value: text, indices } of matches) {
      const listItem = document.createElement("div");
      resultList.appendChild(listItem);

      const matchTitleDiv = document.createElement("div");
      matchTitleDiv.classList.add("match-title");
      matchTitleDiv.innerText = chatTitle;
      listItem.appendChild(matchTitleDiv);

      const matchTextDiv = document.createElement("div");
      const messageType = key === "prompt" ? "prompt" : "response";
      matchTextDiv.classList.add("match-text", messageType);
      listItem.appendChild(matchTextDiv);

      let index = 0;

      for (const [start, end] of indices) {
        // add the unhighlighted run of text, if it exists
        if (start > 0) {
          const cutText = cut(
            text.substring(index, start),
            index === 0 ? "left" : "middle"
          );
          const unhighlighted = document.createTextNode(cutText);
          matchTextDiv.appendChild(unhighlighted);
        }

        // add the highlighted run
        const highlighted = document.createElement("span");
        highlighted.classList.add("match-run");
        highlighted.innerText = text.substring(start, end + 1);
        matchTextDiv.appendChild(highlighted);

        // move the index to the end of the highlighted run
        index = end + 1;
      }
      // add the unhighlighted remainder if any
      const remainder = text.substring(index);
      if (remainder) {
        const unhighlighted = document.createTextNode(cut(remainder, "right"));
        matchTextDiv.appendChild(unhighlighted);
      }

      matchTextDiv.addEventListener("click", () => {
        ipcRenderer.send("go-to", { chatId, requestId, messageType });
      });
    }
  }
});

const cut = (text, cutPosition, runLength = 6) => {
  const arr = text.split(/\b/);

  if (arr.length <= runLength) {
    return text;
  }
  if (cutPosition === "middle" && arr.length <= runLength * 2) {
    return text;
  }

  switch (cutPosition) {
    case "middle":
      return [
        ...arr.slice(0, runLength),
        " ... ",
        ...arr.slice(-runLength),
      ].join("");
    case "left":
      return ["... ", ...arr.slice(-runLength)].join("");
    case "right":
      return [...arr.slice(0, runLength), " ..."].join("");
    default:
      throw new Error(`wrong cut position: ${cutPosition}`);
  }
};
