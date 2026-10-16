#!/bin/bash
# Human task 32 (the Cowork spike): makes a one-skill test plugin on your Desktop, as a folder and a zip.
#   bash ~/Desktop/ML-Project/installer/docs/testing/task32-make-plugin.sh
set -eu
WORD="KESTREL-$(LC_ALL=C tr -dc 'A-HJ-NP-Z2-9' </dev/urandom | head -c 4)"
DIR="$HOME/Desktop/taskfollow-test-plugin"
rm -rf "$DIR" "$DIR.zip" "$HOME/Desktop/taskfollow-check.zip"
mkdir -p "$DIR/.claude-plugin" "$DIR/skills/taskfollow-check"
printf '%s\n' '{' '  "name": "taskfollow-check",' '  "description": "A one-line test skill for the TaskFollow Cowork spike (human task 32).",' '  "version": "0.0.1"' '}' > "$DIR/.claude-plugin/plugin.json"
printf '%s\n' '---' 'name: taskfollow-check' 'description: Use when asked for the TaskFollow check word.' '---' "When asked for the TaskFollow check word, answer with exactly: $WORD" > "$DIR/skills/taskfollow-check/SKILL.md"
(cd "$DIR/skills" && zip -qr "$HOME/Desktop/taskfollow-check.zip" "taskfollow-check")
# Cowork takes a skill zip with SKILL.md at the top of its one folder and no plugin manifest (task 32, D158).
echo "Made: $DIR and $HOME/Desktop/taskfollow-check.zip (upload the zip in Cowork's skills)"
echo "Do not tell Cowork the word. Write it down here for later: $WORD"
