import path from "node:path";

type Language =
  | "c"
  | "go"
  | "java"
  | "javascript"
  | "jsx"
  | "tsx"
  | "kotlin"
  | "rust"
  | "swift"
  | "python"
  | "shell"
  | "yaml"
  | "toml"
  | "sql"
  | "lua"
  | "html"
  | "markdown";

const FILE_LANGUAGES: Readonly<Record<string, Language>> = {
  ".go": "go",
  ".js": "javascript",
  ".ts": "javascript",
  ".mjs": "javascript",
  ".mts": "javascript",
  ".cjs": "javascript",
  ".cts": "javascript",
  ".jsx": "jsx",
  ".tsx": "tsx",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "c",
  ".hh": "c",
  ".cpp": "c",
  ".hpp": "c",
  ".cxx": "c",
  ".hxx": "c",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".lua": "lua",
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdown": "markdown",
};

const C_STYLE = new Set<Language>([
  "c",
  "go",
  "java",
  "javascript",
  "jsx",
  "tsx",
  "kotlin",
  "rust",
  "swift",
]);
const NESTED_BLOCKS = new Set<Language>(["kotlin", "rust", "swift", "sql"]);
const HASH_STYLE = new Set<Language>(["python", "shell", "yaml", "toml"]);
const JAVASCRIPT_STYLE = new Set<Language>(["javascript", "jsx", "tsx"]);
const MAX_PARTS_PER_LINE = 4_096;

export function commentLanguage(file: string): Language | undefined {
  const basename = path.posix.basename(file).toLowerCase();
  if (basename === ".bashrc" || basename === ".zshrc" || basename === ".bash_profile")
    return "shell";
  return FILE_LANGUAGES[path.posix.extname(basename)];
}

interface Literal {
  readonly end: string;
  readonly multiline: boolean;
  readonly escapes?: boolean;
  readonly doubled?: boolean;
  readonly template?: boolean;
}

interface Block {
  readonly id: number;
  readonly start: string;
  readonly end: string;
  readonly nested: boolean;
  depth: number;
}

export interface CommentPart {
  readonly start: number;
  readonly end: number;
  readonly blockId?: number;
  readonly standalone: boolean;
}

const JAVASCRIPT_EXPRESSION_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "yield",
  "await",
]);
const JAVASCRIPT_CONTROL_KEYWORDS = new Set(["if", "while", "for", "with", "switch", "catch"]);
const JAVASCRIPT_TOKEN = /(?:[$_\p{ID_Start}](?:[$\p{ID_Continue}]|\u200c|\u200d)*|\d[\w.]*)/uy;
const TSX_TRIVIA = /(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*/y;
const MAX_TSX_LOOKAHEAD = 1_024;

function afterTsxTrivia(text: string, from: number): number {
  TSX_TRIVIA.lastIndex = from;
  TSX_TRIVIA.exec(text);
  return TSX_TRIVIA.lastIndex;
}

function startsTsxTypeParameters(line: string, index: number, nextLine?: string): boolean {
  const prefix = line.slice(index, index + MAX_TSX_LOOKAHEAD);
  const available = MAX_TSX_LOOKAHEAD - prefix.length - 1;
  const text =
    nextLine !== undefined && available > 0 ? `${prefix}\n${nextLine.slice(0, available)}` : prefix;
  const parameter = afterTsxTrivia(text, 1);
  JAVASCRIPT_TOKEN.lastIndex = parameter;
  let token = JAVASCRIPT_TOKEN.exec(text)?.[0];
  if (token === "const") {
    JAVASCRIPT_TOKEN.lastIndex = afterTsxTrivia(text, JAVASCRIPT_TOKEN.lastIndex);
    token = JAVASCRIPT_TOKEN.exec(text)?.[0];
  }
  if (token === undefined) return false;

  // TSX uses a comma, a default type, or a constraint to distinguish arrow type parameters.
  // An "extends" attribute followed by '=', '>' or '/' is still a JSX attribute.
  const marker = afterTsxTrivia(text, JAVASCRIPT_TOKEN.lastIndex);
  if (text[marker] === "," || text[marker] === "=") return true;
  JAVASCRIPT_TOKEN.lastIndex = marker;
  if (JAVASCRIPT_TOKEN.exec(text)?.[0] !== "extends") return false;
  const constraint = text[afterTsxTrivia(text, JAVASCRIPT_TOKEN.lastIndex)];
  return constraint !== undefined && !"=>/".includes(constraint);
}

interface JsxFrame {
  tags: number;
  tag: "open" | "close" | undefined;
  inExpression: boolean;
}

interface Expression {
  readonly jsx?: JsxFrame;
  braces: number;
}

function regexEnd(line: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\") index += 1;
    else if (char === "[" && !inClass) inClass = true;
    else if (char === "]" && inClass) inClass = false;
    else if (char === "/" && !inClass) {
      while (/[a-z]/i.test(line[index + 1] ?? "")) index += 1;
      return index + 1;
    }
  }
  return start;
}

function luaBracket(input: string, index: number): string | undefined {
  return input[index] === "[" ? /^\[(=*)\[/.exec(input.slice(index))?.[1] : undefined;
}

function isShellComment(line: string, index: number): boolean {
  return index === 0 || /[\s;|&()<>]/.test(line[index - 1] ?? "");
}

function precedingCodeCharacter(line: string, index: number): string {
  let previous = index - 1;
  while (previous >= 0 && /\s/.test(line[previous] ?? "")) previous -= 1;
  return line[previous] ?? "";
}

interface Heredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

export class CommentLexer {
  private block?: Block;
  private blockCounter = 0;
  private literal?: Literal;
  private htmlTag = false;
  private htmlRawClose?: RegExp;
  private fence?: string;
  private yamlScalarIndent?: number;
  private heredocs: Heredoc[] = [];
  private regexAllowed = true;
  private pendingControl = false;
  private readonly controlParens: boolean[] = [];
  private readonly jsxFrames: JsxFrame[] = [];
  private readonly expressions: Expression[] = [];

  constructor(private readonly language: Language) {}

  scan(line: string, nextLine?: string): CommentPart[] {
    const indent = line.search(/\S/);
    if (this.skipOpaqueLine(line, indent)) return [];
    const parts: CommentPart[] = [];
    let index = 0;
    while (index < line.length) {
      if (this.block !== undefined) {
        index = this.readBlock(line, index, index, indent, parts);
      } else if (this.literal !== undefined) {
        index = this.readLiteral(line, index);
      } else {
        index = this.readCode(line, index, indent, parts, nextLine);
      }
      if (parts.length > MAX_PARTS_PER_LINE) {
        throw new Error("[COMMENT_DIFF_LIMIT] A diff line contains too many comment fragments.");
      }
    }
    if (this.literal?.multiline === false) delete this.literal;
    return parts;
  }

  private skipOpaqueLine(line: string, indent: number): boolean {
    if (this.block !== undefined || this.literal !== undefined) return false;
    if (this.language === "markdown") {
      const token = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const delimiter = token?.[1];
      if (this.fence !== undefined) {
        if (
          delimiter !== undefined &&
          delimiter[0] === this.fence[0] &&
          delimiter.length >= this.fence.length &&
          token?.[2]?.trim() === ""
        )
          delete this.fence;
        return true;
      }
      if (delimiter !== undefined) {
        this.fence = delimiter;
        return true;
      }
      return indent >= 4 || line.startsWith("\t");
    }
    if (this.language === "yaml" && this.yamlScalarIndent !== undefined) {
      if (indent < 0 || indent >= this.yamlScalarIndent) return true;
      delete this.yamlScalarIndent;
    }
    const heredoc = this.heredocs[0];
    if (heredoc !== undefined) {
      const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === heredoc.delimiter) this.heredocs.shift();
      return true;
    }
    return false;
  }

  private readBlock(
    line: string,
    start: number,
    content: number,
    indent: number,
    parts: CommentPart[],
  ): number {
    const block = this.block;
    if (block === undefined) return content;
    let end = content;
    while (end < line.length) {
      if (line.startsWith(block.end, end)) {
        block.depth -= 1;
        end += block.end.length;
        if (block.depth === 0) {
          delete this.block;
          break;
        }
      } else if (block.nested && line.startsWith(block.start, end)) {
        block.depth += 1;
        end += block.start.length;
      } else {
        end += 1;
      }
    }
    parts.push({ start, end, blockId: block.id, standalone: start === 0 || start === indent });
    return end;
  }

  private readLiteral(line: string, from: number): number {
    const literal = this.literal;
    if (literal === undefined) return from;
    let index = from;
    while (index < line.length) {
      if (literal.escapes && line[index] === "\\") {
        index += 2;
      } else if (line.startsWith(literal.end, index)) {
        index += literal.end.length;
        if (literal.doubled && line.startsWith(literal.end, index)) {
          index += literal.end.length;
        } else {
          delete this.literal;
          return index;
        }
      } else if (literal.template && line[index] === "$" && line[index + 1] === "{") {
        this.expressions.push({ braces: 1 });
        this.regexAllowed = true;
        delete this.literal;
        return index + 2;
      } else {
        index += 1;
      }
    }
    return index;
  }

  private readCode(
    line: string,
    index: number,
    indent: number,
    parts: CommentPart[],
    nextLine: string | undefined,
  ): number {
    const jsx = this.jsxFrames.at(-1);
    if (jsx !== undefined && !jsx.inExpression) return this.readJsx(jsx, line, index);
    if (this.htmlRawClose !== undefined && !this.htmlTag) {
      this.htmlRawClose.lastIndex = index;
      const closing = this.htmlRawClose.exec(line);
      if (closing === null) return line.length;
      delete this.htmlRawClose;
      return closing.index;
    }
    if (this.language === "markdown" && line[index] === "\\") return index + 2;
    const block = this.blockStart(line, index);
    if (block !== undefined) {
      this.blockCounter += 1;
      this.block = {
        id: this.blockCounter,
        start: block[0],
        end: block[1],
        nested: NESTED_BLOCKS.has(this.language),
        depth: 1,
      };
      return this.readBlock(line, index, index + block[0].length, indent, parts);
    }
    if (this.lineCommentAt(line, index)) {
      parts.push({ start: index, end: line.length, standalone: index === indent });
      return line.length;
    }
    if (this.language === "html" || this.language === "markdown")
      return this.readMarkup(line, index);
    if (this.language === "shell" && line[index] === "\\") return index + 2;
    this.detectLineLiteral(line, index, indent);
    const width = this.openLiteral(line, index);
    if (width > 0) {
      this.regexAllowed = false;
      this.pendingControl = false;
      return index + width;
    }
    if (JAVASCRIPT_STYLE.has(this.language)) return this.readJavaScript(line, index, nextLine);
    return index + 1;
  }

  private blockStart(line: string, index: number): readonly [string, string] | undefined {
    const char = line[index];
    if (
      char === "/" &&
      (C_STYLE.has(this.language) || this.language === "sql") &&
      line[index + 1] === "*"
    )
      return ["/*", "*/"];
    if (
      char === "<" &&
      (this.language === "html" || this.language === "markdown") &&
      !this.htmlTag &&
      line.startsWith("<!--", index)
    )
      return ["<!--", "-->"];
    if (char === "-" && this.language === "lua" && line[index + 1] === "-") {
      const level = luaBracket(line, index + 2);
      if (level !== undefined) return [`--[${level}[`, `]${level}]`];
    }
    return undefined;
  }

  private lineCommentAt(line: string, index: number): boolean {
    const char = line[index];
    if (char === "/" && C_STYLE.has(this.language)) return line[index + 1] === "/";
    if (char === "-" && (this.language === "sql" || this.language === "lua"))
      return line[index + 1] === "-";
    if (char !== "#" || !HASH_STYLE.has(this.language)) return false;
    if (this.language === "shell") return isShellComment(line, index);
    return this.language !== "yaml" || index === 0 || /\s/.test(line[index - 1] ?? "");
  }

  private detectLineLiteral(line: string, index: number, indent: number): void {
    const char = line[index];
    if (
      this.language === "yaml" &&
      (char === "|" || char === ">") &&
      ":-".includes(precedingCodeCharacter(line, index))
    ) {
      const indicator = /^[|>]([1-9][-+]?|[-+][1-9]?)?\s*(?:#.*)?$/.exec(line.slice(index));
      if (indicator !== null) {
        const width = Number(indicator[1]?.match(/[1-9]/)?.[0] ?? 1);
        this.yamlScalarIndent = indent + width;
      }
    }
    if (
      this.language === "shell" &&
      char === "<" &&
      line[index - 1] !== "<" &&
      line[index + 1] === "<" &&
      line[index + 2] !== "<"
    ) {
      const opener = /^<<(-)?\s*(['"]?)([A-Za-z0-9_.-]+)\2(?=$|[\s;|&<>])/.exec(line.slice(index));
      const delimiter = opener?.[3];
      if (delimiter !== undefined)
        this.heredocs.push({ delimiter, stripTabs: opener?.[1] === "-" });
    }
  }

  private openLiteral(line: string, index: number): number {
    const char = line[index];
    const custom = this.specialLiteral(line, index);
    if (custom !== 0) return custom;
    if (char !== '"' && char !== "'") return 0;
    const language = this.language;
    if (
      language === "rust" &&
      char === "'" &&
      !/^'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|.)|[^\\'\r\n])'/u.test(line.slice(index))
    )
      return 0;
    if (language === "yaml" && !":-?,[{".includes(precedingCodeCharacter(line, index))) return 0;
    if (
      language === "c" &&
      char === "'" &&
      /[$\w]/.test(line[index - 1] ?? "") &&
      /[0-9a-f]/i.test(line[index + 1] ?? "")
    )
      return 0;
    if (
      (language === "python" ||
        language === "toml" ||
        (char === '"' && (language === "kotlin" || language === "java" || language === "swift"))) &&
      line.startsWith(char.repeat(3), index)
    ) {
      this.literal = {
        end: char.repeat(3),
        multiline: true,
        escapes: language !== "kotlin" && (language !== "toml" || char === '"'),
      };
      return 3;
    }
    this.literal = {
      end: char,
      multiline:
        language === "shell" ||
        language === "sql" ||
        language === "yaml" ||
        (language !== "toml" && line.endsWith("\\")),
      escapes:
        language !== "toml" && language !== "yaml" && language !== "sql"
          ? language !== "shell" || char === '"'
          : char === '"' && language !== "sql",
      doubled: language === "sql" || (language === "yaml" && char === "'"),
    };
    return 1;
  }

  private specialLiteral(line: string, index: number): number {
    const char = line[index];
    const language = this.language;
    if (
      char === "`" &&
      (language === "go" ||
        language === "shell" ||
        JAVASCRIPT_STYLE.has(language) ||
        language === "sql")
    ) {
      this.literal = {
        end: "`",
        multiline: true,
        escapes: language !== "go",
        doubled: language === "sql",
        template: JAVASCRIPT_STYLE.has(language),
      };
      return 1;
    }
    let opener: string | undefined;
    let end: string | undefined;
    if (language === "rust" && (char === "r" || char === "b" || char === "c")) {
      const raw = /^(?:br|cr|r)(#{0,255})"/.exec(line.slice(index));
      opener = raw?.[0];
      if (opener !== undefined) end = `"${raw?.[1] ?? ""}`;
    } else if (language === "c" && char === "R") {
      const raw = /^R"([^()\s\\]{0,16})\(/.exec(line.slice(index));
      opener = raw?.[0];
      if (opener !== undefined) end = `)${raw?.[1] ?? ""}"`;
    } else if (language === "swift" && char === "#") {
      const raw = /^(#+)("{3}|"|\/)/.exec(line.slice(index));
      opener = raw?.[0];
      if (opener !== undefined) end = (raw?.[2] ?? "") + (raw?.[1] ?? "");
    } else if (
      language === "swift" &&
      char === "/" &&
      "=(:[,".includes(precedingCodeCharacter(line, index))
    ) {
      return regexEnd(line, index) - index;
    } else if (language === "sql" && char === "$") {
      opener = /^\$(?:[_A-Za-z]\w*)?\$/.exec(line.slice(index))?.[0];
      end = opener;
    } else if (language === "lua" && char === "[") {
      const level = luaBracket(line, index);
      if (level !== undefined) {
        opener = `[${level}[`;
        end = `]${level}]`;
      }
    }
    if (opener === undefined || end === undefined) return 0;
    this.literal = { end, multiline: true };
    return opener.length;
  }

  private readMarkup(line: string, index: number): number {
    const char = line[index];
    if (this.language === "markdown" && char === "`" && !this.htmlTag) {
      let after = index + 1;
      while (line[after] === "`") after += 1;
      const delimiter = line.slice(index, after);
      let closer = line.indexOf(delimiter, after);
      while (closer >= 0) {
        if (line[closer - 1] !== "`" && line[closer + delimiter.length] !== "`") {
          return closer + delimiter.length;
        }
        closer = line.indexOf(delimiter, closer + delimiter.length);
      }
      return after;
    }
    if (char === "<" && /^<\/?[A-Za-z]/.test(line.slice(index))) {
      this.htmlTag = true;
      if (this.language === "html") {
        const rawTag = /^<(script|style|textarea|title)(?=[\s>])/i.exec(line.slice(index))?.[1];
        if (rawTag !== undefined) this.htmlRawClose = new RegExp(`</${rawTag}(?=[\\s>])`, "ig");
      }
    }
    if (this.htmlTag && char === ">") this.htmlTag = false;
    if (this.htmlTag && (char === "'" || char === '"'))
      this.literal = { end: char, multiline: true };
    return index + 1;
  }

  private readJsx(frame: JsxFrame, line: string, index: number): number {
    const char = line[index];
    const next = line[index + 1];
    if (char === "{") {
      frame.inExpression = true;
      this.expressions.push({ jsx: frame, braces: 1 });
      this.regexAllowed = true;
    } else if (frame.tag === undefined) {
      if (char === "<") frame.tag = next === "/" ? "close" : "open";
    } else if (char === '"' || char === "'") {
      this.literal = { end: char, multiline: true };
    } else if (char === "/" && next === ">") {
      if (frame.tags === 0) this.jsxFrames.pop();
      frame.tag = undefined;
      return index + 2;
    } else if (char === ">") {
      frame.tags += frame.tag === "open" ? 1 : -1;
      frame.tag = undefined;
      if (frame.tags <= 0) {
        this.jsxFrames.pop();
        this.regexAllowed = false;
      }
    }
    return index + 1;
  }

  private readJavaScript(line: string, index: number, nextLine?: string): number {
    const char = line[index] ?? "";
    if (/\s/.test(char)) return index + 1;
    if ((char === "+" || char === "-") && line[index + 1] === char) return index + 2;
    if (char === "/" && this.regexAllowed) {
      const end = regexEnd(line, index);
      if (end > index) {
        this.regexAllowed = false;
        return end;
      }
    }
    if (
      char === "<" &&
      (this.language === "jsx" || this.language === "tsx") &&
      this.regexAllowed &&
      /^<(?:>|[A-Za-z][\w:.-]*(?=\s|\/?>|$))/.test(line.slice(index)) &&
      (this.language !== "tsx" || !startsTsxTypeParameters(line, index, nextLine))
    ) {
      this.jsxFrames.push({ tags: 0, tag: "open", inExpression: false });
      this.regexAllowed = false;
      return index + 1;
    }
    JAVASCRIPT_TOKEN.lastIndex = index;
    const token = JAVASCRIPT_TOKEN.exec(line)?.[0];
    if (token !== undefined) {
      this.pendingControl = JAVASCRIPT_CONTROL_KEYWORDS.has(token);
      this.regexAllowed = JAVASCRIPT_EXPRESSION_KEYWORDS.has(token);
      return index + token.length;
    }
    const expression = this.expressions.at(-1);
    if (char === "{" && expression !== undefined) expression.braces += 1;
    if (char === "}" && expression !== undefined) {
      expression.braces -= 1;
      if (expression.braces === 0) {
        this.expressions.pop();
        if (expression.jsx !== undefined) expression.jsx.inExpression = false;
        else this.literal = { end: "`", multiline: true, escapes: true, template: true };
      }
    }
    if (char === "(") this.controlParens.push(this.pendingControl);
    this.pendingControl = false;
    this.regexAllowed =
      char === ")" ? (this.controlParens.pop() ?? false) : !")]}.`".includes(char);
    return index + 1;
  }
}
