const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

function loadCommands(context) {
    // Read TSV shipped in the extension and build a map:
    // base command -> array of { command, variant, args, signature, desc }
    // Also store command+variant as keys for exact matches
    const csvPath = path.join(context.extensionPath, "valid_commands.csv");
    let data = "";
    try {
        data = fs.readFileSync(csvPath, "utf8");
    } catch (e) {
        console.error("Could not read valid_commands.csv", e);
        return { byCommand: new Map(), byComposite: new Map() };
    }
    const lines = data.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // accept header starting with "command" (case-insensitive)
    if (lines.length && /^command\s*/i.test(lines[0])) lines.shift(); // drop header

    const byCommand = new Map(); // command -> array of entries
    const byComposite = new Map(); // "command variant" -> entry

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
        // split on tab into Command, Variant, Args, Description
        const parts = line.split("\t");
        if (!parts[0]) continue;
        const command = parts[0].trim();
        const variant = (parts[1] || "").trim();
        const args = (parts[2] || "").trim();
        const desc = (parts.slice(3).join("\t") || "").replace(/""/g, '"').trim();

        const commandKey = normalizeKey(command);
        const signature = args ? `${command} ${args}` : command;
        const entry = { command, variant, args, signature, desc };

        // Store by base command
        if (!byCommand.has(commandKey)) {
            byCommand.set(commandKey, []);
        }
        byCommand.get(commandKey).push(entry);

        // Also store by composite key for quick exact match
        if (variant) {
            const compositeKey = `${commandKey} ${normalizeKey(variant)}`;
            byComposite.set(compositeKey, entry);
        }
    }
    return { byCommand, byComposite };
}

// Escape text for use in RegExp
function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

function findCommandAtPosition(commandMap, document, position) {
    const { byCommand, byComposite } = commandMap;
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

    // Try to match: start from current token, then look back 1-4 tokens for command + variant
    const maxLen = 4; // command up to 4 tokens (e.g., "open d3plot" = 2 tokens)
    for (let len = Math.min(maxLen, tokens.length); len >= 1; len--) {
        const start = Math.max(0, idx - (len - 1));
        if (start + len > tokens.length) continue;

        const candidateRaw = tokens.slice(start, start + len).join(" ");
        const candidateKey = candidateRaw.replace(/\s+/g, " ").toLowerCase();

        // try exact composite match first (command + variant)
        if (byComposite.has(candidateKey)) {
            const entry = byComposite.get(candidateKey);
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

    // fallback: try first token as base command and return first entry
    if (tokens.length > 0) {
        const firstToken = tokens[0].toLowerCase();
        if (byCommand.has(firstToken)) {
            const entries = byCommand.get(firstToken);
            // return the first entry (or the one without variant if available)
            const entry = entries.find(e => !e.variant) || entries[0];
            const re = new RegExp("\\b" + escapeRegExp(firstToken) + "\\b", "i");
            const match = re.exec(lineText);
            let range = document.getWordRangeAtPosition(position) || new vscode.Range(position, position);
            if (match) {
                range = new vscode.Range(position.line, match.index, position.line, match.index + match[0].length);
            }
            return { entry, range };
        }
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
    const { byCommand, byComposite } = commandMap;
    const seen = new Set();

    // Add all composite entries (variants)
    for (const [key, { signature, desc }] of byComposite.entries()) {
        if (seen.has(signature)) continue;
        seen.add(signature);
        const item = new vscode.CompletionItem(signature, vscode.CompletionItemKind.Keyword);
        item.detail = signature;
        if (desc) item.documentation = new vscode.MarkdownString(desc);
        item.insertText = signature;
        completionItems.push(item);
    }

    // Add base command entries (no variant)
    for (const [cmd, entries] of byCommand.entries()) {
        for (const { signature, desc } of entries) {
            if (seen.has(signature)) continue;
            seen.add(signature);
            const item = new vscode.CompletionItem(signature, vscode.CompletionItemKind.Keyword);
            item.detail = signature;
            if (desc) item.documentation = new vscode.MarkdownString(desc);
            item.insertText = signature;
            completionItems.push(item);
        }
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
