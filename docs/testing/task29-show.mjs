// Prints a `claude -p --output-format stream-json` run as three lines: the answer, whether it failed, and the tools called.
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk)).on("end", () => {
  const used = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.log("raw:", line);
      continue;
    }
    if (event.type === "assistant") {
      for (const part of event.message?.content ?? []) {
        if (part.type === "tool_use") used.push(`${part.name} ${JSON.stringify(part.input)}`);
      }
    }
    if (event.type === "result") {
      console.log("result:", event.result);
      console.log("is_error:", event.is_error);
    }
  }
  console.log("tools called:", used.length > 0 ? used.join(" | ") : "none");
});
