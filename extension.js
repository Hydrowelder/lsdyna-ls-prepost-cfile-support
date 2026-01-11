const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

function loadCommands(context) {
    // Read TSV shipped in the extension and build a map:
    // key = normalized command (no args) -> { command, args, signature, desc, tokenCount }
    const csvPath = path.join(context.extensionPath, "valid_commands.csv");
    let data = "";
    try {
        data = fs.readFileSync(csvPath, "utf8");
    } catch (e) {
        console.error("Could not read valid_commands.csv", e);
        return new Map();
    }
    const lines = data.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // accept header starting with "command" (case-insensitive)
    if (lines.length && /^command\s*/i.test(lines[0])) lines.shift(); // drop header

    const map = new Map();

    function normalizeKey(text) {
        let t = String(text).trim();
        t = t.replace(/""/g, '"');
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
            t = t.slice(1, -1);
        }
        t = t.replace(/\s+/g, " ").toLowerCase();
        return t;
    }

    for (const line of lines) {
        // split on tab into Command, Args, Description
        const parts = line.split("\t");
        if (!parts[0]) continue;
        const command = parts[0].trim();
        const args = (parts[1] || "").trim();
        const desc = (parts.slice(2).join("\t") || "").replace(/""/g, '"').trim();
        const key = normalizeKey(command); // match only the command (not args)
        const signature = args ? `${command} ${args}` : command;
        const tokenCount = key.split(/\s+/).filter(Boolean).length;
        map.set(key, { command, args, signature, desc, tokenCount });
    }
    return map;
}

// Escape text for use in RegExp
function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

function findCommandAtPosition(commandMap, document, position) {
    const lineText = document.lineAt(position.line).text;
    const trimmed = lineText.trim();
    if (!trimmed) return null;
    // don't show hover for comment lines (start with c or C)
    if (/^\s*[cC]\b/.test(lineText)) return null;

    const tokens = lineText.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;

    // compute token index under cursor by counting tokens before cursor
    const beforeText = lineText.slice(0, position.character);
    const beforeTokens = beforeText.trim().split(/\s+/).filter(Boolean);
    const idx = Math.max(0, beforeTokens.length - 1);

    const maxLen = 5; // allow matching up to 5-token commands
    for (let len = Math.min(maxLen, tokens.length); len >= 1; len--) {
        const start = idx - (len - 1);
        if (start < 0) continue;
        const candidateRaw = tokens.slice(start, start + len).join(" ");
        const candidateKey = candidateRaw.replace(/\s+/g, " ").toLowerCase();
        if (commandMap.has(candidateKey)) {
            const entry = commandMap.get(candidateKey);
            // build regex that tolerates variable whitespace between tokens
            const candidateRegex = escapeRegExp(candidateRaw).replace(/\s+/g, "\\s+");
            const re = new RegExp("\\b" + candidateRegex + "\\b", "i");
            const match = re.exec(lineText);
            let range = document.getWordRangeAtPosition(position) || new vscode.Range(position, position);
            if (match) {
                range = new vscode.Range(position.line, match.index, position.line, match.index + match[0].length);
            }
            return { entry, range };
        }
    }

    // fallback: try single word normalized
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return null;
    const word = document.getText(wordRange).toLowerCase();
    if (commandMap.has(word)) {
        return { entry: commandMap.get(word), range: wordRange };
    }

    return null;
}

function activate(context) {
    const commandMap = loadCommands(context);

    const hoverProvider = vscode.languages.registerHoverProvider("lsppcfile", {
        provideHover(document, position) {
            const found = findCommandAtPosition(commandMap, document, position);
            if (!found) return null;
            const { entry, range } = found;
            const md = new vscode.MarkdownString();
            // Signature block
            md.appendMarkdown("**Command**\n\n");
            md.appendCodeblock(entry.signature, "plaintext");
            if (entry.desc) {
                md.appendMarkdown("\n**Description**\n\n");
                md.appendMarkdown(entry.desc);
            }
            return new vscode.Hover(md, range);
        },
    });
    context.subscriptions.push(hoverProvider);

    // Pre-create completion items for all commands with documentation
    const completionItems = [];
    for (const [key, { signature, desc }] of commandMap.entries()) {
        const item = new vscode.CompletionItem(signature, vscode.CompletionItemKind.Keyword);
        item.detail = signature;
        if (desc) item.documentation = new vscode.MarkdownString(desc);
        item.insertText = signature;
        completionItems.push(item);
    }

    const completionProvider = vscode.languages.registerCompletionItemProvider(
        "lsppcfile",
        {
            provideCompletionItems() {
                return completionItems;
            },
        },
        // trigger on space as well so typing "anim " will show options (optional)
        " "
    );
    context.subscriptions.push(completionProvider);
}

function deactivate() { }

module.exports = { activate, deactivate };
