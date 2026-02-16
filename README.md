<p align="center">
  <img src="icon.png" width="200" height="200">
</p>

# AIChat-to-Notes (Obsidian-first)
A Chrome extension that sends Gemini, ChatGPT, and NotebookLM responses directly to **Obsidian**. It preserves key Markdown structure (headings, lists, code, math, links, quotes) and adds a one-click export button under assistant responses.

> Note: Notion support exists in code, but **Notion UI/actions are currently hidden** until Obsidian testing is fully complete.

### Motivation

Have you ever found yourself constantly copying and pasting responses from Gemini (Google AI) into your personal notes, only to be frustrated by the tedious process and broken formatting? This script was born out of that very frustration. Manually transferring information from the web to Obsidian (and eventually Notion), especially when dealing with rich content like tables or code blocks, is not only time-consuming but often results in a loss of valuable formatting. This project aims to streamline that workflow, ensuring your AI-generated insights are seamlessly integrated into your knowledge base.

## Features

- **One-Click Export**: Adds a **Send to Obsidian** button directly under Gemini/ChatGPT/NotebookLM assistant responses.
- **No Separate AI API Billing**: Uses web AI services directly, so you can avoid managing additional model API usage costs for this workflow.
- **Rich Formatting**: Preserves tables, bold/italic text, and lists.
- **Math Support**: Support for inline and block math formulas using LaTeX.
- **Customizable**: Set your Obsidian endpoint + API key.

> [!NOTE]
> **Disclaimer**: This tool was built to address specific formatting challenges I encountered, particularly with **math formulas** and **bold text**. While I have strived to solve these problems, please note that there may still be unresolved issues or edge cases.

## Installation (Chrome Extension)

1. Open Chrome Extensions page: `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `chrome-extension` folder in this repository.

## Configuration

Click the extension icon and open settings:

- **Obsidian URL**: your Obsidian Local REST API base URL
- **Obsidian Key**: your Obsidian API token
- *(Optional)* **LM Studio** settings if you use the Local LLM title mode

### Important Note on Chrome & Local HTTP

> [!WARNING]
> Obsidian Local REST API is typically local HTTP (`http://127.0.0.1:27123`). This is handled by the extension background script.

## Usage

![Usage Example](example.png)

1. Open [Gemini](https://gemini.google.com/), [ChatGPT](https://chatgpt.com/), or [NotebookLM](https://notebooklm.google.com/).
2. Start a conversation or view an existing one.
3. You will see a button at the bottom of each assistant response: **Send to Obsidian**.
4. Click the button.
5. Enter a title for the note when prompted.
6. A success message will appear once the transfer is complete.

---

*This project was created with the help of **Gemini**.*

## License

MIT License
