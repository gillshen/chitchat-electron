# Chitchat

A ChatGPT client built using Electron.js.

## Usage

1. Clone the repository and `cd` into it.

2. Install dependencies by running
```
npm install
```

3. Put your OpenAI API key in a file and place the file in the same directory as `main.js`. The file should be named `chat_settings.json` and look like this:
```
{ "key": "sk-****************************************" }
```

4. Start the app by running
```
npm start
```

While not madatory, it's recommended to install the [Open Sans font](https://fonts.google.com/specimen/Open+Sans) if you haven't already.

## Features

Already implemented:
- Automatic local storage of chat history (in `chat_history.sqlite`)
- Fulltext search acrocss multiple conversations
- Exporting chat history to CSV files
- Clearing chat context (useful if you're constantly running into the context length limit but don't want to start a new chat)

TODO
- Add a plaintext mode to address the Markdown rendering issue (issue 2 below)
- User-defined, editable system messages
- User-set completion parameters
- Finer-grained control of chat contexts

## Known Issues

1. Unlike its Python API, OpenAI's Javascript API doens't support streaming yet. So, instead of starting to get the first word of a reponse one second after sending your prompt, you might have to wait for three seconds and then get the entire response in one fell swoop.

2. The app assumes that ChatGPT's responses are valid Markdown text, which they almost always are. But very occasionally (typically when it tries to draw a table) ChatGPT may return invalid Markdown, causing problems for rendering (e.g. the app may only show you the correctly formmatted parts of the response). Still the original response will be saved in the chat history and can be viewed by either using an SQLite browser or exporting to a CSV file.
