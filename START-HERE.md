# Start here

This page is for you, not for your computer. TaskFollow turns the AI assistant you already have into one that knows your work: it sets itself up step by step, finds the jobs you repeat, runs them for you, and always asks you before anything is sent, paid or deleted. This page gets you from nothing to a helper who sets everything up for you. You do not need to know anything technical. You will need:

- a **Mac** or a **Windows 11** computer,
- an account with Anthropic that can use **Claude Code** (it is the helper; a paid Claude plan works),
- the **Telegram** app on your phone only if you want messages there when you are away from the computer (without it, your assistant tells you everything in its own chat), and your own **Google account** if you keep your contacts in a Google Sheet. The helper asks what you use and tells you what you need,
- some time without interruptions. If you get stuck, you can stop and carry on later.

## 1. Install Node

Node is a small program TaskFollow needs. Go to https://nodejs.org, download the version marked **LTS**, open the file and click through the installer.

## 2. Open a terminal

A terminal is a window where you type commands.

- **Mac:** press the Command key and the space bar together, type `Terminal`, press Return.
- **Windows:** press the Windows key, type `cmd`, press Enter. Use this one (Command Prompt), not PowerShell.

To paste something into it, use Command and V on a Mac, or a right-click on Windows.

## 3. Install Claude Code

Paste this line, press Return, and wait until it finishes:

```
npm install -g @anthropic-ai/claude-code
```

On a Mac it may say "permission denied". If so, paste `sudo npm install -g @anthropic-ai/claude-code` instead and type your computer's password when asked. Nothing shows while you type it, and that is normal.

## 4. Make a folder and start Claude Code

Paste these lines one at a time. On a Mac:

```
mkdir -p ~/Desktop/taskfollow
cd ~/Desktop/taskfollow
claude
```

On Windows:

```
mkdir %USERPROFILE%\Desktop\taskfollow
cd %USERPROFILE%\Desktop\taskfollow
claude
```

Claude Code opens in the same window. Sign in when it asks, and say yes if it asks whether you trust this folder.

## 5. Give it one sentence

Paste this into Claude Code and press Return:

> Please install TaskFollow for me. Run `npx --yes taskfollow instructions` and follow exactly what it prints. I am not technical: explain each step in plain words and tell me exactly what to click or type.

From here the helper leads. It will ask you questions, and sometimes ask you to open a **new** terminal window and paste a line there. That is on purpose: some decisions are only yours to make.

## If something goes wrong

- **Never paste a password, a key or a secret into the chat with Claude.** TaskFollow opens its own page on your computer for those, and the helper will tell you when.
- Tell Claude exactly what you see on the screen. It can help.
- If the window closes: open a terminal again, paste the `cd` line from step 4 to go back to your folder, and type `claude --continue`. It picks up where you stopped.
