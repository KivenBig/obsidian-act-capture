import {
  App,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  normalizePath,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  setTooltip,
  TFile,
  TFolder,
  WorkspaceLeaf,
  requestUrl
} from "obsidian";

const VIEW_TYPE = "act-capture-view";
const PAGE_SIZE = 10;
const MAX_PREVIEW_LIMIT = 50;
const MOBILE_STARTUP_OPEN_DELAY_MS = 900;
const DESKTOP_STARTUP_OPEN_DELAY_MS = 0;
const MOBILE_PREVIEW_LOAD_DELAY_MS = 700;
const DESKTOP_PREVIEW_LOAD_DELAY_MS = 80;
const MOBILE_AUTO_FOCUS_DELAY_MS = 650;
const DESKTOP_AUTO_FOCUS_DELAY_MS = 120;
const UPDATE_REPO = "KivenBig/obsidian-act-capture";
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

type StorageMode = "daily" | "single";

interface MobileDailyCaptureSettings {
  storageMode: StorageMode;
  dailyFolder: string;
  dailyFileNameFormat: string;
  thoughtHeading: string;
  singleNotePath: string;
  singleEntryHeadingFormat: string;
  projectNotesFolder: string;
  selectedProjectNotePath: string;
  dailyTemplatePath: string;
  openOnMobileStartup: boolean;
  openOnDesktopStartup: boolean;
  draftText: string;
  draftUpdatedAt: number;
}

const DEFAULT_SETTINGS: MobileDailyCaptureSettings = {
  storageMode: "daily",
  dailyFolder: "Daily Notes",
  dailyFileNameFormat: "YYYY-MM-DD",
  dailyTemplatePath: "",
  thoughtHeading: "每日闪念",
  singleNotePath: "每日闪念.md",
  singleEntryHeadingFormat: "YYYYMMDD HH:mm",
  projectNotesFolder: "",
  selectedProjectNotePath: "",
  openOnMobileStartup: true,
  openOnDesktopStartup: false,
  draftText: "",
  draftUpdatedAt: 0
};

interface ThoughtEntry {
  startLine: number;
  endLine: number;
  time: string;
  body: string;
  source: string;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function isMobileRuntime(): boolean {
  return Platform.isMobileApp || Platform.isMobile;
}

function formatDateOnly(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getWeekdayShortName(date: Date): string {
  return ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
}

function getWeekdayFullName(date: Date): string {
  return `周${getWeekdayShortName(date)}`;
}

function getWeekdayDisplayName(date: Date): string {
  const shortName = getWeekdayShortName(date);
  return shortName === "日" ? "星期日" : `星期${shortName}`;
}

function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(date: Date): string {
  return `${formatDateOnly(date)} ${formatTime(date)}`;
}

function formatEditorDateLabel(date: Date): string {
  return `今天，${getWeekdayDisplayName(date)}`;
}

function formatCompactDate(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanHeadingText(value: string): string {
  return value.trim().replace(/^#{1,6}\s*/, "").trim() || DEFAULT_SETTINGS.thoughtHeading;
}

function applyDateFormat(format: string, date: Date): string {
  return format
    .replace(/\{date\}/g, formatDateOnly(date))
    .replace(/\{compactDate\}/g, formatCompactDate(date))
    .replace(/\{datetime\}/g, formatDateTime(date))
    .replace(/\{time\}/g, formatTime(date))
    .replace(/\{year\}/g, `${date.getFullYear()}`)
    .replace(/\{month\}/g, pad(date.getMonth() + 1))
    .replace(/\{day\}/g, pad(date.getDate()))
    .replace(/\{weekdayFull\}/g, getWeekdayFullName(date))
    .replace(/\{weekday\}/g, getWeekdayShortName(date))
    .replace(/YYYY/g, `${date.getFullYear()}`)
    .replace(/YY/g, `${date.getFullYear()}`.slice(-2))
    .replace(/MM/g, pad(date.getMonth() + 1))
    .replace(/DD/g, pad(date.getDate()))
    .replace(/HH/g, pad(date.getHours()))
    .replace(/mm/g, pad(date.getMinutes()));
}

function formatDailyFileName(format: string, date: Date): string {
  const safeFormat = format.trim() || DEFAULT_SETTINGS.dailyFileNameFormat;
  // 过滤文件名非法字符（保留 / 以支持子文件夹）
  const fileName = applyDateFormat(safeFormat, date).replace(/[\\:*?"<>|]/g, "-");
  return fileName.endsWith(".md") ? fileName : `${fileName}.md`;
}

function formatSingleEntryHeading(format: string, date: Date): string {
  const safeFormat = format.trim() || DEFAULT_SETTINGS.singleEntryHeadingFormat;
  return applyDateFormat(safeFormat, date).trim() || formatDateTime(date);
}

function joinVaultPath(folder: string, fileName: string): string {
  const cleanFolder = normalizeFolderPath(folder);
  return normalizePath(cleanFolder ? `${cleanFolder}/${fileName}` : fileName);
}

function normalizeFolderPath(path: string): string {
  const cleanPath = path.trim().replace(/^\/+|\/+$/g, "");
  return cleanPath ? normalizePath(cleanPath) : "";
}

function normalizeNotePath(path: string): string {
  const cleanPath = normalizePath(path.trim().replace(/^\/+/, "") || DEFAULT_SETTINGS.singleNotePath);
  return cleanPath.endsWith(".md") ? cleanPath : `${cleanPath}.md`;
}

function normalizeProjectNoteName(name: string): string {
  const cleanName = sanitizeFileName(name).replace(/\.md$/i, "").trim();
  return cleanName ? `${cleanName}.md` : "";
}

function getParentFolderPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function sanitizeFileName(fileName: string): string {
  const cleanName = fileName.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ");
  return cleanName || "附件";
}

function buildAttachmentEmbed(file: TFile): string {
  const isImage = /^(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.extension);
  return `${isImage ? "!" : ""}[[${file.path}]]`;
}

// 压缩连续空行；含代码块围栏时跳过，避免破坏代码块内的空行
function squeezeBlankLines(text: string): string {
  if (text.includes("```") || text.includes("~~~")) return text;
  return text.replace(/\n{4,}/g, "\n\n\n");
}

// 判断标题是否像本插件生成的时间戳标题（以数字开头且至少含 6 位数字）
function isTimestampLikeHeading(title: string): boolean {
  return /^\d/.test(title.trim()) && (title.match(/\d/g) ?? []).length >= 6;
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
}

function isThoughtHeading(line: string, heading: string): boolean {
  const pattern = new RegExp(`^#{1,6}\\s*${escapeRegExp(cleanHeadingText(heading))}\\s*$`);
  return pattern.test(line.trim());
}

function buildEntry(text: string, date: Date): string {
  const lines = text.trim().split(/\r?\n/);
  const firstLine = lines.shift() ?? "";
  const rest = lines.map((line) => `  ${line}`);
  return [`- ${formatTime(date)} ${firstLine}`, ...rest].join("\n");
}

function buildSingleNoteEntry(text: string, title: string): string {
  return `## ${title}\n\n${text.trim()}`;
}

function insertThought(content: string, entry: string, heading: string): string {
  const lines = content.split("\n");
  const cleanHeading = cleanHeadingText(heading);
  const existingHeadingIndex = lines.findIndex((line) => isThoughtHeading(line, cleanHeading));

  if (existingHeadingIndex >= 0) {
    let insertIndex = lines.length;
    for (let i = existingHeadingIndex + 1; i < lines.length; i++) {
      if (isHeading(lines[i]) || /^---\s*$/.test(lines[i])) {
        insertIndex = i;
        break;
      }
    }

    const before = lines.slice(0, insertIndex);
    const after = lines.slice(insertIndex);
    if (before[before.length - 1]?.trim()) before.push("");
    before.push(entry);
    before.push("");
    return squeezeBlankLines([...before, ...after].join("\n"));
  }

  const summaryIndex = lines.findIndex((line) => /^##\s+今日总结\s*$/.test(line.trim()));
  let insertIndex = summaryIndex >= 0 ? summaryIndex : lines.length;
  if (summaryIndex > 0 && /^---\s*$/.test(lines[summaryIndex - 2]?.trim())) {
    insertIndex = summaryIndex - 2;
  } else if (summaryIndex > 0 && /^---\s*$/.test(lines[summaryIndex - 1]?.trim())) {
    insertIndex = summaryIndex - 1;
  }

  const section = ["", `## ${cleanHeading}`, "", entry, ""];
  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);
  while (before.length > 0 && before[before.length - 1] === "") before.pop();
  return squeezeBlankLines([...before, ...section, ...after].join("\n"));
}

function isThoughtEntryStart(line: string): boolean {
  return /^-\s+\d{2}:\d{2}\s*/.test(line.trim());
}

function sortThoughtsNewestFirst(thoughts: ThoughtEntry[]): ThoughtEntry[] {
  return thoughts.sort((a, b) => b.time.localeCompare(a.time));
}

function extractThoughts(content: string, heading: string): ThoughtEntry[] {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => isThoughtHeading(line, heading));
  if (headingIndex < 0) return [];

  const thoughts: ThoughtEntry[] = [];
  let i = headingIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (isHeading(line) || /^---\s*$/.test(line)) break;

    const match = line.trim().match(/^-\s+(\d{2}:\d{2})\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const startLine = i;
    const bodyLines = [match[2] ?? ""];
    i++;
    while (i < lines.length) {
      const nextLine = lines[i];
      if (isHeading(nextLine) || /^---\s*$/.test(nextLine) || isThoughtEntryStart(nextLine)) break;
      bodyLines.push(nextLine.replace(/^\s{2}/, ""));
      i++;
    }

    const endLine = i - 1;
    thoughts.push({
      startLine,
      endLine,
      time: match[1],
      body: bodyLines.join("\n").trim(),
      source: lines.slice(startLine, endLine + 1).join("\n")
    });
  }
  return sortThoughtsNewestFirst(thoughts);
}

function findThoughtRange(content: string, target: ThoughtEntry, heading: string): { startLine: number; endLine: number } {
  const lines = content.split("\n");
  let startLine = target.startLine;
  let endLine = target.endLine;
  const currentSource = lines.slice(startLine, endLine + 1).join("\n");

  if (currentSource !== target.source) {
    const thoughts = extractThoughts(content, heading);
    const freshTarget = thoughts.find((thought) => thought.source === target.source);
    if (!freshTarget) throw new Error("Thought entry was not found.");
    startLine = freshTarget.startLine;
    endLine = freshTarget.endLine;
  }

  return { startLine, endLine };
}

function replaceThought(content: string, target: ThoughtEntry, newBody: string, heading: string): string {
  const lines = content.split("\n");
  const { startLine, endLine } = findThoughtRange(content, target, heading);
  const replacement = buildEntry(newBody, new Date()).replace(/^- \d{2}:\d{2}/, `- ${target.time}`).split("\n");
  lines.splice(startLine, endLine - startLine + 1, ...replacement);
  return lines.join("\n");
}

function deleteThought(content: string, target: ThoughtEntry, heading: string): string {
  const lines = content.split("\n");
  const { startLine, endLine } = findThoughtRange(content, target, heading);
  let deleteEnd = endLine;
  if (lines[deleteEnd + 1] === "") deleteEnd++;
  lines.splice(startLine, deleteEnd - startLine + 1);
  return squeezeBlankLines(lines.join("\n"));
}

function isSingleEntryHeading(line: string): boolean {
  return /^##\s+\S+/.test(line.trim());
}

function extractSingleNoteThoughts(content: string, limit?: number): ThoughtEntry[] {
  const lines = content.split("\n");
  const thoughts: ThoughtEntry[] = [];
  let i = 0;

  while (i < lines.length) {
    const match = lines[i].trim().match(/^##\s+(.+)$/);
    if (!match) {
      i++;
      continue;
    }

    const startLine = i;
    const time = match[1].trim();
    const bodyLines: string[] = [];
    i++;

    while (i < lines.length) {
      if (isSingleEntryHeading(lines[i])) break;
      bodyLines.push(lines[i]);
      i++;
    }

    const endLine = i - 1;
    const body = bodyLines.join("\n").trim();
    thoughts.push({
      startLine,
      endLine,
      time,
      body,
      source: lines.slice(startLine, endLine + 1).join("\n").trim()
    });

    if (limit !== undefined && thoughts.length >= limit) break;
  }

  return sortThoughtsNewestFirst(thoughts);
}

function extractSingleNotePreviewThoughts(content: string, limit: number): ThoughtEntry[] {
  const thoughts: ThoughtEntry[] = [];
  let index = 0;
  let lineNumber = 0;
  let current: {
    startLine: number;
    sourceStart: number;
    time: string;
    bodyLines: string[];
  } | null = null;

  const finishCurrent = (sourceEnd: number, endLine: number): void => {
    if (!current) return;
    thoughts.push({
      startLine: current.startLine,
      endLine,
      time: current.time,
      body: current.bodyLines.join("\n").trim(),
      source: content.slice(current.sourceStart, sourceEnd).trim()
    });
    current = null;
  };

  while (index <= content.length) {
    const nextNewline = content.indexOf("\n", index);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const rawLine = content.slice(index, lineEnd).replace(/\r$/, "");
    const headingMatch = rawLine.trim().match(/^##\s+(.+)$/);

    if (headingMatch) {
      finishCurrent(index, lineNumber - 1);
      if (thoughts.length >= limit) break;
      current = {
        startLine: lineNumber,
        sourceStart: index,
        time: headingMatch[1].trim(),
        bodyLines: []
      };
    } else if (current) {
      current.bodyLines.push(rawLine);
    }

    if (nextNewline === -1) break;
    index = nextNewline + 1;
    lineNumber++;
  }

  if (thoughts.length < limit) finishCurrent(content.length, lineNumber);
  return sortThoughtsNewestFirst(thoughts);
}

function findSingleNoteThoughtRange(content: string, target: ThoughtEntry): { startLine: number; endLine: number } {
  const lines = content.split("\n");
  let startLine = target.startLine;
  let endLine = target.endLine;
  const currentSource = lines.slice(startLine, endLine + 1).join("\n").trim();

  if (currentSource !== target.source) {
    const thoughts = extractSingleNoteThoughts(content);
    const freshTarget = thoughts.find((thought) => thought.source === target.source);
    if (!freshTarget) throw new Error("Thought entry was not found.");
    startLine = freshTarget.startLine;
    endLine = freshTarget.endLine;
  }

  return { startLine, endLine };
}

function insertSingleNoteThought(content: string, entry: string): string {
  const cleanContent = content.replace(/\s+$/g, "");
  if (!cleanContent) return `${entry}\n`;

  const lines = cleanContent.split("\n");
  const firstEntryIndex = lines.findIndex(isSingleEntryHeading);
  if (firstEntryIndex >= 0) {
    const before = lines.slice(0, firstEntryIndex);
    const after = lines.slice(firstEntryIndex);
    while (before.length > 0 && before[before.length - 1] === "") before.pop();
    return squeezeBlankLines([...before, "", entry, "", ...after].join("\n"));
  }

  return `${cleanContent}\n\n${entry}\n`;
}

function sortSingleNoteContentNewestFirst(content: string): string {
  const lines = content.split("\n");
  const firstEntryIndex = lines.findIndex(isSingleEntryHeading);
  if (firstEntryIndex < 0) return content;

  const leading = lines.slice(0, firstEntryIndex).join("\n").replace(/\s+$/g, "");
  const thoughts = extractSingleNoteThoughts(content);
  // 安全守卫：只有所有 ## 标题都是时间戳格式时才重排。
  // 否则说明这是一篇含普通章节标题的笔记，重排会破坏原有结构。
  if (thoughts.some((thought) => !isTimestampLikeHeading(thought.time))) return content;
  const body = thoughts.map((thought) => thought.source).join("\n\n");
  return leading ? `${leading}\n\n${body}\n` : `${body}\n`;
}

function replaceSingleNoteThought(content: string, target: ThoughtEntry, newBody: string): string {
  const lines = content.split("\n");
  const { startLine, endLine } = findSingleNoteThoughtRange(content, target);
  const replacement = buildSingleNoteEntry(newBody, target.time).split("\n");
  lines.splice(startLine, endLine - startLine + 1, ...replacement);
  return squeezeBlankLines(lines.join("\n"));
}

function deleteSingleNoteThought(content: string, target: ThoughtEntry): string {
  const lines = content.split("\n");
  const { startLine, endLine } = findSingleNoteThoughtRange(content, target);
  let deleteEnd = endLine;
  while (lines[deleteEnd + 1] === "") deleteEnd++;
  lines.splice(startLine, deleteEnd - startLine + 1);
  return squeezeBlankLines(lines.join("\n"));
}

class ProjectNoteNameModal extends Modal {
  private submitted = false;
  private value = "";
  private onSubmit: (value: string) => void;

  constructor(app: App, onSubmit: (value: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.setTitle("新建项目笔记");

    let textInputEl: HTMLInputElement | null = null;
    const submit = () => {
      const trimmedValue = this.value.trim();
      if (!trimmedValue) {
        new Notice("请输入笔记名称");
        textInputEl?.focus();
        return;
      }

      this.submitted = true;
      this.onSubmit(trimmedValue);
      this.close();
    };

    new Setting(this.contentEl)
      .setName("笔记名称")
      .setDesc("创建后会保存到当前项目闪念文件夹，并自动切换为写入目标。")
      .addText((text) => {
        text
          .setPlaceholder("例如：课程思考")
          .onChange((value) => {
            this.value = value;
          });
        textInputEl = text.inputEl;
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        });
        window.setTimeout(() => text.inputEl.focus(), 30);
      });

    new Setting(this.contentEl)
      .addButton((button) => {
        button.setButtonText("取消").onClick(() => this.close());
      })
      .addButton((button) => {
        button.setButtonText("创建").setCta().onClick(() => submit());
      });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.onSubmit("");
  }
}

class ProjectNoteSelectModal extends Modal {
  private files: TFile[];
  private currentPath: string;
  private onSelect: (file: TFile) => void | Promise<void>;

  constructor(app: App, files: TFile[], currentPath: string, onSelect: (file: TFile) => void | Promise<void>) {
    super(app);
    this.files = files;
    this.currentPath = currentPath;
    this.onSelect = onSelect;
  }

  onOpen(): void {
    this.setTitle("选择写入笔记");
    const listEl = this.contentEl.createDiv({ cls: "act-capture-note-select" });

    if (this.files.length === 0) {
      listEl.createDiv({
        cls: "act-capture-note-select__empty",
        text: "项目闪念文件夹里还没有可选笔记。"
      });
      return;
    }

    for (const file of this.files) {
      const button = listEl.createEl("button", {
        cls: `act-capture-note-select__item ${file.path === this.currentPath ? "is-active" : ""}`,
        attr: { type: "button" }
      });
      button.createSpan({ cls: "act-capture-note-select__name", text: file.basename });
      button.createSpan({ cls: "act-capture-note-select__path", text: file.path });
      if (file.path === this.currentPath) {
        button.createSpan({ cls: "act-capture-note-select__current", text: "当前" });
      }
      button.addEventListener("click", () => {
        void this.onSelect(file);
        this.close();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DailyCaptureView extends ItemView {
  private plugin: MobileDailyCapturePlugin;
  private inputEl: HTMLTextAreaElement | null = null;
  private currentProjectLabelEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;
  private draftSaveTimer: number | null = null;
  private previewLoadTimer: number | null = null;
  private lastSelectionStart = 0;
  private lastSelectionEnd = 0;
  private visibleLimit = PAGE_SIZE;

  constructor(leaf: WorkspaceLeaf, plugin: MobileDailyCapturePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "ACT 闪念簿";
  }

  getIcon(): string {
    return "message-square-plus";
  }

  async onOpen(): Promise<void> {
    this.clearPreviewLoadTimer();
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("act-capture");

    if (!this.app.workspace.layoutReady) {
      // Obsidian 正处于启动/logo 阶段（workspace 还原），把 DOM 构建推到下
      // 一个宏任务，让 Obsidian 先完成还原并隐藏 logo，再构建界面
      window.setTimeout(() => this.buildUI(root), 0);
      return;
    }
    this.buildUI(root);
  }

  private buildUI(root: HTMLElement): void {
    const composer = root.createDiv({ cls: "act-capture__composer" });
    const topbar = composer.createDiv({ cls: "act-capture__topbar" });
    const topbarMain = topbar.createDiv({ cls: "act-capture__topbar-main" });
    const topbarActions = topbar.createDiv({ cls: "act-capture__topbar-actions" });

    if (this.plugin.settings.storageMode === "single") {
      const selectButton = topbarActions.createEl("button", {
        cls: "act-capture__secondary act-capture__compact-action act-capture__select-note",
        text: "选择",
        attr: {
          type: "button",
          "aria-label": "选择写入笔记"
        }
      });
      setTooltip(selectButton, "选择写入笔记");
      selectButton.addEventListener("click", () => {
        this.openProjectNoteSelector();
      });

      const newNoteButton = topbarActions.createEl("button", {
        cls: "act-capture__secondary act-capture__compact-action act-capture__new-note",
        text: "新建"
      });
      newNoteButton.addEventListener("click", () => {
        void this.createProjectNote();
      });
    }
    const fullscreenButton = topbarActions.createEl("button", {
      cls: "act-capture__secondary act-capture__compact-action act-capture__focus-toggle",
      text: "聚焦"
    });
    fullscreenButton.addEventListener("click", () => {
      this.toggleMainFullscreen(composer, fullscreenButton);
    });
    const saveButton = topbarActions.createEl("button", {
      cls: "act-capture__primary act-capture__topbar-save",
      text: "保存 →"
    });
    saveButton.addEventListener("click", () => {
      void this.saveInput();
    });
    this.createProjectNoteStatus(topbarMain);

    const editor = composer.createDiv({ cls: "act-capture__editor" });
    const editorHeader = editor.createDiv({ cls: "act-capture__editor-header" });
    editorHeader.createSpan({ cls: "act-capture__editor-dot" });
    editorHeader.createSpan({ cls: "act-capture__editor-time", text: formatEditorDateLabel(new Date()) });
    const openNoteButton = editorHeader.createEl("button", {
      cls: "act-capture__editor-menu",
      text: "⋯",
      attr: {
        type: "button",
        "aria-label": "打开当前写入笔记"
      }
    });
    setTooltip(openNoteButton, "打开当前写入笔记");
    openNoteButton.addEventListener("click", () => {
      void this.plugin.openCaptureNote();
    });

    this.inputEl = editor.createEl("textarea", {
      cls: "act-capture__input",
      attr: {
        placeholder: "你现在在想什么？",
        rows: "7"
      }
    });
    this.inputEl.value = this.plugin.settings.draftText;

    const editorFooter = editor.createDiv({ cls: "act-capture__editor-footer" });
    const toolbar = editorFooter.createDiv({ cls: "act-capture__toolbar" });
    this.createEditorToolButton(toolbar, "标题", "heading", "#", () => this.insertAtCursor("#"));
    this.createEditorToolButton(toolbar, "加粗", "bold", "B", () => this.wrapSelection("**", "**", "加粗文字"));
    this.createEditorToolButton(toolbar, "项目符号", "list", null, () => this.insertBullet());
    this.createEditorToolButton(toolbar, "添加附件", "paperclip", null, () => {
      void this.pickAttachment();
    });

    this.inputEl.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void this.saveInput();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        this.wrapSelection("**", "**", "加粗文字");
        return;
      }
      if (event.key === "Escape" && composer.hasClass("is-focus-editor")) {
        event.preventDefault();
        this.setMainFullscreen(composer, fullscreenButton, false);
        return;
      }
      this.handleListKeydown(event);
    });
    this.inputEl.addEventListener("input", () => {
      this.rememberInputSelection();
      this.queueDraftSave();
    });
    this.inputEl.addEventListener("select", () => {
      this.rememberInputSelection();
    });
    this.inputEl.addEventListener("keyup", () => {
      this.rememberInputSelection();
    });
    this.inputEl.addEventListener("mouseup", () => {
      this.rememberInputSelection();
    });
    this.inputEl.addEventListener("touchend", () => {
      window.setTimeout(() => this.rememberInputSelection(), 0);
    });
    this.inputEl.addEventListener("focus", () => {
      this.rememberInputSelection();
      this.setKeyboardMode(root, true);
    });
    this.inputEl.addEventListener("blur", () => {
      this.setKeyboardMode(root, false);
      void this.flushDraft();
    });

    const preview = root.createDiv({ cls: "act-capture__preview" });
    const sectionTitle = this.plugin.settings.storageMode === "single" ? "最近的闪念" : "今天的闪念";
    preview.createDiv({ cls: "act-capture__section-title", text: sectionTitle });
    this.previewEl = preview.createDiv({ cls: "act-capture__list" });
    this.footerEl = preview.createDiv({ cls: "act-capture__footer" });

    this.previewEl.createDiv({
      cls: "act-capture__empty",
      text: "正在载入最近闪念..."
    });
    this.schedulePreviewLoad();
    window.setTimeout(
      () => this.inputEl?.focus(),
      isMobileRuntime() ? MOBILE_AUTO_FOCUS_DELAY_MS : DESKTOP_AUTO_FOCUS_DELAY_MS
    );
  }

  private createProjectNoteStatus(container: HTMLElement): void {
    if (this.plugin.settings.storageMode !== "single") return;
    this.currentProjectLabelEl = container.createDiv({ cls: "act-capture__current-note" });
    this.updateCurrentProjectLabel();
  }

  private updateCurrentProjectLabel(): void {
    if (!this.currentProjectLabelEl) return;
    this.currentProjectLabelEl.setText(`写入：${this.plugin.getCaptureDisplayName(new Date())}`);
  }

  private openProjectNoteSelector(): void {
    const files = this.plugin.getProjectNoteFiles();
    const currentPath = this.plugin.getSingleCapturePath();
    new ProjectNoteSelectModal(this.app, files, currentPath, async (file) => {
      await this.plugin.setSelectedProjectNotePath(file.path);
      this.updateCurrentProjectLabel();
      this.visibleLimit = PAGE_SIZE;
      await this.refreshPreview();
      this.inputEl?.focus();
    }).open();
  }

  private async createProjectNote(): Promise<void> {
    new ProjectNoteNameModal(this.app, (name) => {
      if (!name) return;
      void this.finishCreatingProjectNote(name);
    }).open();
  }

  private async finishCreatingProjectNote(name: string): Promise<void> {
    const file = await this.plugin.createProjectNote(name);
    if (!file) return;

    await this.plugin.setSelectedProjectNotePath(file.path);
    this.updateCurrentProjectLabel();
    this.visibleLimit = PAGE_SIZE;
    await this.refreshPreview();
    this.inputEl?.focus();
    new Notice(`已新建项目笔记：${file.basename}`);
  }

  private createEditorToolButton(
    container: HTMLElement,
    tooltip: string,
    icon: string,
    text: string | null,
    onClick: () => void
  ): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "act-capture__tool-button",
      attr: {
        type: "button",
        "aria-label": tooltip
      }
    });
    if (text) {
      button.setText(text);
    } else {
      setIcon(button, icon);
    }
    setTooltip(button, tooltip);
    let handledByPointer = false;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.restoreInputSelection();
    });
    button.addEventListener("pointerup", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handledByPointer = true;
      this.restoreInputSelection();
      onClick();
      window.setTimeout(() => {
        handledByPointer = false;
      }, 0);
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (handledByPointer) return;
      this.restoreInputSelection();
      onClick();
    });
    return button;
  }

  private setKeyboardMode(root: HTMLElement, active: boolean): void {
    if (!isMobileRuntime()) return;
    root.toggleClass("is-keyboard-active", active);

    if (active) {
      window.setTimeout(() => {
        this.inputEl?.closest(".act-capture__editor")?.scrollIntoView({
          block: "start",
          behavior: "smooth"
        });
      }, 80);
    }
  }

  private rememberInputSelection(): void {
    if (!this.inputEl) return;
    this.lastSelectionStart = this.inputEl.selectionStart ?? this.inputEl.value.length;
    this.lastSelectionEnd = this.inputEl.selectionEnd ?? this.lastSelectionStart;
  }

  private restoreInputSelection(): void {
    if (!this.inputEl) return;
    const valueLength = this.inputEl.value.length;
    const start = Math.min(this.lastSelectionStart, valueLength);
    const end = Math.min(this.lastSelectionEnd, valueLength);
    this.inputEl.focus({ preventScroll: true });
    this.inputEl.setSelectionRange(start, end);
  }

  private getInputSelection(): { start: number; end: number } {
    if (!this.inputEl) return { start: 0, end: 0 };

    if (document.activeElement === this.inputEl) {
      this.rememberInputSelection();
    } else {
      this.restoreInputSelection();
    }

    return {
      start: this.lastSelectionStart,
      end: this.lastSelectionEnd
    };
  }

  private insertAtCursor(text: string): void {
    if (!this.inputEl) return;
    const { start, end } = this.getInputSelection();
    this.inputEl.setRangeText(text, start, end, "end");
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.restoreInputSelection();
    this.queueDraftSave();
  }

  private wrapSelection(prefix: string, suffix: string, placeholder: string): void {
    if (!this.inputEl) return;
    const { start, end } = this.getInputSelection();
    const selectedText = this.inputEl.value.slice(start, end) || placeholder;
    const replacement = `${prefix}${selectedText}${suffix}`;
    this.inputEl.setRangeText(replacement, start, end, "select");
    this.inputEl.selectionStart = start + prefix.length;
    this.inputEl.selectionEnd = start + prefix.length + selectedText.length;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.rememberInputSelection();
    this.restoreInputSelection();
    this.queueDraftSave();
  }

  private insertLinePrefix(prefix: string): void {
    if (!this.inputEl) return;
    const { start, end } = this.getInputSelection();
    const value = this.inputEl.value;
    const lineStart = value.lastIndexOf("\n", Math.max(start - 1, 0)) + 1;
    const selectedText = value.slice(start, end);

    if (selectedText.includes("\n")) {
      const replacement = selectedText
        .split("\n")
        .map((line) => line.trim() ? `${prefix}${line}` : line)
        .join("\n");
      this.inputEl.setRangeText(replacement, start, end, "end");
    } else {
      this.inputEl.setRangeText(prefix, lineStart, lineStart, "end");
    }

    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.restoreInputSelection();
    this.queueDraftSave();
  }

  private insertBullet(): void {
    if (!this.inputEl) return;
    const { start, end } = this.getInputSelection();
    const selectedText = this.inputEl.value.slice(start, end);

    if (selectedText.includes("\n")) {
      const bulletText = selectedText
        .split("\n")
        .map((line) => line.trim() ? `- ${line}` : line)
        .join("\n");
      this.inputEl.setRangeText(bulletText, start, end, "end");
    } else {
      const lineStart = this.inputEl.value.lastIndexOf("\n", Math.max(start - 1, 0)) + 1;
      const beforeCursor = this.inputEl.value.slice(lineStart, start);
      const insertText = beforeCursor.trim().length === 0 ? "- " : "\n- ";
      this.inputEl.setRangeText(insertText, start, end, "end");
    }

    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.restoreInputSelection();
    this.queueDraftSave();
  }

  private insertTask(): void {
    if (!this.inputEl) return;
    const { start, end } = this.getInputSelection();
    const selectedText = this.inputEl.value.slice(start, end);

    if (selectedText.includes("\n")) {
      const taskText = selectedText
        .split("\n")
        .map((line) => line.trim() ? `- [ ] ${line}` : line)
        .join("\n");
      this.inputEl.setRangeText(taskText, start, end, "end");
    } else {
      const lineStart = this.inputEl.value.lastIndexOf("\n", Math.max(start - 1, 0)) + 1;
      const beforeCursor = this.inputEl.value.slice(lineStart, start);
      const insertText = beforeCursor.trim().length === 0 ? "- [ ] " : "\n- [ ] ";
      this.inputEl.setRangeText(insertText, start, end, "end");
    }

    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.restoreInputSelection();
    this.queueDraftSave();
  }

  private insertMarkdownLink(): void {
    if (!this.inputEl) return;
    const { start, end } = this.getInputSelection();
    const selectedText = this.inputEl.value.slice(start, end) || "链接文字";
    const replacement = `[${selectedText}](https://)`;
    this.inputEl.setRangeText(replacement, start, end, "select");
    const urlStart = start + selectedText.length + 3;
    this.inputEl.selectionStart = urlStart;
    this.inputEl.selectionEnd = urlStart + "https://".length;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.rememberInputSelection();
    this.restoreInputSelection();
    this.queueDraftSave();
  }

  private handleListKeydown(event: KeyboardEvent): void {
    if (!this.inputEl) return;

    const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const lineStart = this.inputEl.value.lastIndexOf("\n", Math.max(cursor - 1, 0)) + 1;
    const lineBeforeCursor = this.inputEl.value.slice(lineStart, cursor);

    if (event.key === "Enter") {
      const bulletMatch = lineBeforeCursor.match(/^(\s*)-\s(?:\[( |x|X)\]\s)?(.*)$/);
      if (!bulletMatch) return;

      event.preventDefault();
      if (bulletMatch[3].trim().length === 0) {
        this.inputEl.setRangeText("\n", lineStart, cursor, "end");
      } else {
        const marker = bulletMatch[2] === undefined ? "- " : "- [ ] ";
        this.inputEl.setRangeText(`\n${bulletMatch[1]}${marker}`, cursor, cursor, "end");
      }
      this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      this.queueDraftSave();
      return;
    }

    if (event.key === "Tab") {
      const lineEnd = this.inputEl.value.indexOf("\n", cursor);
      const currentLine = this.inputEl.value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (!/^\s*-\s/.test(currentLine)) return;

      event.preventDefault();
      if (event.shiftKey) {
        const removeCount = this.inputEl.value.slice(lineStart, lineStart + 2) === "  " ? 2 : 0;
        if (removeCount > 0) this.inputEl.setRangeText("", lineStart, lineStart + removeCount, "end");
      } else {
        this.inputEl.setRangeText("  ", lineStart, lineStart, "end");
      }
      this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      this.queueDraftSave();
    }
  }

  private async pickAttachment(): Promise<void> {
    if (!this.inputEl) return;

    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.addEventListener("change", async () => {
      const files = Array.from(picker.files ?? []);
      if (files.length === 0) return;

      const embeds: string[] = [];
      for (const file of files) {
        const savedFile = await this.plugin.importAttachment(file);
        embeds.push(buildAttachmentEmbed(savedFile));
      }

      this.insertAtCursor(embeds.join("\n"));
      new Notice(files.length === 1 ? "附件已插入" : `已插入 ${files.length} 个附件`);
    });
    picker.click();
  }

  private toggleMainFullscreen(composer: HTMLElement, button: HTMLButtonElement): void {
    this.setMainFullscreen(composer, button, !composer.hasClass("is-focus-editor"));
  }

  private setMainFullscreen(composer: HTMLElement, button: HTMLButtonElement, expanded: boolean): void {
    const root = composer.closest(".act-capture");
    composer.toggleClass("is-focus-editor", expanded);
    root?.toggleClass("is-focus-mode", expanded);
    button.setText(expanded ? "退出" : "聚焦");
    if (expanded) {
      window.setTimeout(() => this.inputEl?.focus(), 30);
    } else {
      this.inputEl?.blur();
    }
  }

  async onClose(): Promise<void> {
    this.clearPreviewLoadTimer();
    await this.flushDraft();
  }

  async rebuildUI(): Promise<void> {
    await this.flushDraft();
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("act-capture");
    this.buildUI(root);
  }

  private async saveInput(): Promise<void> {
    const value = this.inputEl?.value.trim() ?? "";
    if (!value) {
      new Notice("先写一点内容");
      this.inputEl?.focus();
      return;
    }

    await this.plugin.saveThought(value);
    if (this.inputEl) this.inputEl.value = "";
    await this.plugin.saveDraft("");
    this.visibleLimit = PAGE_SIZE;
    await this.refreshPreview();
    this.inputEl?.focus();
    new Notice("保存成功");
  }

  private queueDraftSave(): void {
    if (this.draftSaveTimer !== null) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void this.flushDraft();
    }, 300);
  }

  private async flushDraft(): Promise<void> {
    if (this.draftSaveTimer !== null) {
      window.clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    await this.plugin.saveDraft(this.inputEl?.value ?? "");
  }

  private schedulePreviewLoad(): void {
    this.clearPreviewLoadTimer();
    this.previewLoadTimer = window.setTimeout(() => {
      this.previewLoadTimer = null;
      void this.refreshPreview();
    }, isMobileRuntime() ? MOBILE_PREVIEW_LOAD_DELAY_MS : DESKTOP_PREVIEW_LOAD_DELAY_MS);
  }

  private clearPreviewLoadTimer(): void {
    if (this.previewLoadTimer === null) return;
    window.clearTimeout(this.previewLoadTimer);
    this.previewLoadTimer = null;
  }

  async refreshPreview(): Promise<void> {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.footerEl?.empty();

    const file = await this.plugin.getCaptureFile(false);
    if (!file) {
      this.previewEl.createDiv({
        cls: "act-capture__empty",
        text: "还没有目标笔记，保存第一条闪念时会自动创建。"
      });
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const thoughts = this.plugin.extractPreviewThoughts(content, MAX_PREVIEW_LIMIT);
    if (thoughts.length === 0) {
      this.previewEl.createDiv({
        cls: "act-capture__empty",
        text: "今天还没有闪念。"
      });
      return;
    }

    const cappedThoughts = thoughts.slice(0, MAX_PREVIEW_LIMIT);
    const visibleThoughts = cappedThoughts.slice(0, this.visibleLimit);

    for (const thought of visibleThoughts) {
      await this.renderThought(file, thought);
    }

    if (this.footerEl) {
      const shown = Math.min(visibleThoughts.length, MAX_PREVIEW_LIMIT);
      const total = Math.min(cappedThoughts.length, MAX_PREVIEW_LIMIT);
      this.footerEl.createSpan({
        cls: "act-capture__count",
        text: `已显示 ${shown}/${total}`
      });

      if (shown < total) {
        const moreButton = this.footerEl.createEl("button", {
          cls: "act-capture__secondary act-capture__more",
          text: "刷新更多"
        });
        moreButton.addEventListener("click", () => {
          this.visibleLimit = Math.min(this.visibleLimit + PAGE_SIZE, MAX_PREVIEW_LIMIT);
          void this.refreshPreview();
        });
      }
    }
  }

  private async renderThought(file: TFile, thought: ThoughtEntry): Promise<void> {
    if (!this.previewEl) return;

    const item = this.previewEl.createDiv({ cls: "act-capture__item" });
    const contentEl = item.createDiv({ cls: "act-capture__item-content" });
    await MarkdownRenderer.render(this.app, thought.source, contentEl, file.path, this);

    const actions = item.createDiv({ cls: "act-capture__item-actions" });
    const openButton = actions.createEl("button", {
      cls: "act-capture__item-button",
      text: "跳转"
    });
    openButton.addEventListener("click", () => {
      void this.plugin.openThought(thought);
    });

    const editButton = actions.createEl("button", {
      cls: "act-capture__item-button",
      text: "编辑"
    });
    editButton.addEventListener("click", () => {
      this.renderInlineEditor(item, thought);
    });

    const deleteButton = actions.createEl("button", {
      cls: "act-capture__item-button act-capture__item-button--danger",
      text: "删除"
    });
    deleteButton.addEventListener("click", async () => {
      if (!window.confirm("删除这条闪念？")) return;
      await this.plugin.deleteThought(thought);
      await this.refreshPreview();
      new Notice("闪念已删除");
    });
  }

  private renderInlineEditor(item: HTMLElement, thought: ThoughtEntry): void {
    item.empty();
    const editor = item.createEl("textarea", {
      cls: "act-capture__edit-input",
      attr: {
        rows: "5"
      }
    });
    editor.value = thought.body;

    const actions = item.createDiv({ cls: "act-capture__edit-actions" });
    const cancelButton = actions.createEl("button", {
      cls: "act-capture__item-button",
      text: "取消"
    });
    cancelButton.addEventListener("click", () => {
      void this.refreshPreview();
    });

    const fullscreenButton = actions.createEl("button", {
      cls: "act-capture__item-button",
      text: "全屏"
    });
    fullscreenButton.addEventListener("click", () => {
      const expanded = !item.hasClass("is-fullscreen-editor");
      item.toggleClass("is-fullscreen-editor", expanded);
      fullscreenButton.setText(expanded ? "缩小" : "全屏");
      window.setTimeout(() => editor.focus(), 30);
    });

    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && item.hasClass("is-fullscreen-editor")) {
        event.preventDefault();
        item.removeClass("is-fullscreen-editor");
        fullscreenButton.setText("全屏");
      }
    });

    const saveButton = actions.createEl("button", {
      cls: "act-capture__item-button act-capture__item-button--primary",
      text: "保存"
    });
    saveButton.addEventListener("click", async () => {
      const value = editor.value.trim();
      if (!value) {
        new Notice("内容不能为空");
        editor.focus();
        return;
      }
      await this.plugin.updateThought(thought, value);
      await this.refreshPreview();
      new Notice("闪念已更新");
    });

    window.setTimeout(() => editor.focus(), 60);
  }
}

export default class MobileDailyCapturePlugin extends Plugin {
  settings: MobileDailyCaptureSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new DailyCaptureView(leaf, this));
    this.addSettingTab(new MobileDailyCaptureSettingTab(this.app, this));

    this.addCommand({
      id: "act-capture-open",
      name: "打开闪念簿",
      callback: () => {
        void this.activateView();
      }
    });

    this.addCommand({
      id: "open-today-daily-note",
      name: "打开闪念保存笔记",
      callback: () => {
        void this.openCaptureNote();
      }
    });

    this.app.workspace.onLayoutReady(() => {
      if (this.shouldOpenOnStartup()) {
        const delay = isMobileRuntime() ? MOBILE_STARTUP_OPEN_DELAY_MS : DESKTOP_STARTUP_OPEN_DELAY_MS;
        window.setTimeout(() => void this.activateView(), delay);
      }
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private shouldOpenOnStartup(): boolean {
    if (isMobileRuntime()) return this.settings.openOnMobileStartup;
    return this.settings.openOnDesktopStartup;
  }

  async saveThought(text: string): Promise<void> {
    const file = await this.getCaptureFile(true);
    if (!file) throw new Error("Capture note was not created.");
    if (this.settings.storageMode === "single") {
      const entry = buildSingleNoteEntry(text, this.getSingleEntryHeading(new Date()));
      await this.app.vault.process(file, (content) => sortSingleNoteContentNewestFirst(insertSingleNoteThought(content, entry)));
      return;
    }

    const entry = buildEntry(text, new Date());
    await this.app.vault.process(file, (content) => insertThought(content, entry, this.getThoughtHeading()));
  }

  async updateThought(thought: ThoughtEntry, text: string): Promise<void> {
    const file = await this.getCaptureFile(false);
    if (!file) throw new Error("Capture note was not found.");
    if (this.settings.storageMode === "single") {
      await this.app.vault.process(file, (content) => replaceSingleNoteThought(content, thought, text));
      return;
    }

    await this.app.vault.process(file, (content) => replaceThought(content, thought, text, this.getThoughtHeading()));
  }

  async deleteThought(thought: ThoughtEntry): Promise<void> {
    const file = await this.getCaptureFile(false);
    if (!file) throw new Error("Capture note was not found.");
    if (this.settings.storageMode === "single") {
      await this.app.vault.process(file, (content) => deleteSingleNoteThought(content, thought));
      return;
    }

    await this.app.vault.process(file, (content) => deleteThought(content, thought, this.getThoughtHeading()));
  }

  async openCaptureNote(): Promise<void> {
    const file = await this.getCaptureFile(true);
    if (!file) throw new Error("Capture note was not created.");
    await this.sortSingleNoteIfNeeded(file);
    const leaf = this.getOrCreateLeafForFile(file);
    await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async openThought(thought: ThoughtEntry): Promise<void> {
    const file = await this.getCaptureFile(false);
    if (!file) throw new Error("Capture note was not found.");
    let targetLine = thought.startLine;
    const sortedContent = await this.sortSingleNoteIfNeeded(file);
    if (sortedContent) {
      const freshThought = extractSingleNoteThoughts(sortedContent).find((entry) => entry.source === thought.source);
      if (freshThought) targetLine = freshThought.startLine;
    }
    const leaf = this.getOrCreateLeafForFile(file);
    await leaf.openFile(file, {
      active: true,
      eState: { line: targetLine }
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private getOrCreateLeafForFile(file: TFile): WorkspaceLeaf {
    let existingLeaf: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!existingLeaf && leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        existingLeaf = leaf;
      }
    });
    return existingLeaf ?? this.app.workspace.getLeaf("split", "vertical");
  }

  private async sortSingleNoteIfNeeded(file: TFile): Promise<string | null> {
    if (this.settings.storageMode !== "single") return null;
    const content = await this.app.vault.read(file);
    const sorted = sortSingleNoteContentNewestFirst(content);
    if (sorted !== content) await this.app.vault.modify(file, sorted);
    return sorted;
  }

  async getCaptureFile(createIfMissing: boolean): Promise<TFile | null> {
    const path = this.getCapturePath(new Date());
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    if (!createIfMissing) return null;

    await this.ensureParentFolder(path);
    const template = await this.getCaptureTemplate();
    await this.app.vault.create(path, template);
    const created = this.app.vault.getAbstractFileByPath(path);
    if (created instanceof TFile) return created;
    throw new Error(`Failed to create capture note: ${path}`);
  }

  private async getCaptureTemplate(): Promise<string> {
    if (this.settings.storageMode === "single") {
      const title = this.settings.singleNotePath.split("/").pop()?.replace(/\.md$/i, "") || DEFAULT_SETTINGS.thoughtHeading;
      return `# ${title}\n\n`;
    }

    const templatePath = this.settings.dailyTemplatePath.trim();
    if (templatePath) {
      const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
      if (templateFile instanceof TFile) {
        return await this.app.vault.cachedRead(templateFile);
      }
    }
    return `# ${formatDateOnly(new Date())}\n\n## ${this.getThoughtHeading()}\n\n`;
  }

  extractThoughts(content: string): ThoughtEntry[] {
    if (this.settings.storageMode === "single") return extractSingleNoteThoughts(content);
    return extractThoughts(content, this.getThoughtHeading());
  }

  extractPreviewThoughts(content: string, limit: number): ThoughtEntry[] {
    if (this.settings.storageMode === "single") return extractSingleNotePreviewThoughts(content, limit);
    return extractThoughts(content, this.getThoughtHeading()).slice(0, limit);
  }

  getThoughtHeading(): string {
    return cleanHeadingText(this.settings.thoughtHeading);
  }

  getStorageModeLabel(): string {
    return this.settings.storageMode === "single" ? "单一笔记" : "每日日志";
  }

  getCaptureDisplayName(date: Date): string {
    const path = this.getCapturePath(date);
    const fileName = path.split("/").pop() ?? path;
    return fileName.replace(/\.md$/i, "");
  }

  getSingleEntryHeading(date: Date): string {
    return formatSingleEntryHeading(this.settings.singleEntryHeadingFormat, date);
  }

  getTodayDailyPath(date: Date): string {
    return joinVaultPath(
      this.settings.dailyFolder,
      formatDailyFileName(this.settings.dailyFileNameFormat, date)
    );
  }

  getCapturePath(date: Date): string {
    if (this.settings.storageMode === "single") return this.getSingleCapturePath();
    return this.getTodayDailyPath(date);
  }

  getSingleCapturePath(): string {
    const files = this.getProjectNoteFiles();
    const selected = normalizePath(this.settings.selectedProjectNotePath.trim());
    if (selected && files.some((file) => file.path === selected)) return selected;
    if (files.length > 0) return files[0].path;
    return normalizeNotePath(this.settings.singleNotePath);
  }

  getProjectNoteFiles(): TFile[] {
    const folderPath = normalizeFolderPath(this.settings.projectNotesFolder);
    if (!folderPath) return [];
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return [];
    return folder.children
      .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
      .sort((a, b) => a.basename.localeCompare(b.basename, "zh-CN"));
  }

  getVaultFolders(): TFolder[] {
    return this.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && file.path.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  }

  async setSelectedProjectNotePath(path: string): Promise<void> {
    this.settings.selectedProjectNotePath = path;
    if (path) this.settings.singleNotePath = path;
    await this.saveSettings();
  }

  async createProjectNote(name: string): Promise<TFile | null> {
    const fileName = normalizeProjectNoteName(name);
    if (!fileName) return null;

    const folderPath = normalizeFolderPath(this.settings.projectNotesFolder);
    if (!folderPath) {
      new Notice("请先在设置中配置项目闪念文件夹");
      return null;
    }

    const path = normalizePath(`${folderPath}/${fileName}`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.setSelectedProjectNotePath(existing.path);
      return existing;
    }
    if (existing) {
      new Notice("同名路径已存在，但不是笔记文件");
      return null;
    }

    await this.ensureParentFolder(path);
    const title = fileName.replace(/\.md$/i, "");
    const file = await this.app.vault.create(path, `# ${title}\n\n`);
    await this.setSelectedProjectNotePath(file.path);
    return file;
  }

  async importAttachment(file: File): Promise<TFile> {
    const capturePath = this.getCapturePath(new Date());
    const parentFolder = getParentFolderPath(capturePath);
    const attachmentFolder = normalizePath(parentFolder ? `${parentFolder}/附件` : "附件");
    const fileName = sanitizeFileName(file.name);
    const targetPath = await this.getAvailableAttachmentPath(attachmentFolder, fileName);

    await this.ensureParentFolder(targetPath);
    return this.app.vault.createBinary(targetPath, await file.arrayBuffer());
  }

  private async getAvailableAttachmentPath(folder: string, fileName: string): Promise<string> {
    const normalizedName = sanitizeFileName(fileName);
    const dotIndex = normalizedName.lastIndexOf(".");
    const baseName = dotIndex > 0 ? normalizedName.slice(0, dotIndex) : normalizedName;
    const extension = dotIndex > 0 ? normalizedName.slice(dotIndex) : "";

    let index = 0;
    while (true) {
      const suffix = index === 0 ? "" : `-${index}`;
      const candidate = normalizePath(`${folder}/${baseName}${suffix}${extension}`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
      index++;
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    if (parts.length === 0) return;

    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`Path exists and is not a folder: ${currentPath}`);
      await this.app.vault.createFolder(currentPath);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveDraft(text: string): Promise<void> {
    if (this.settings.draftText === text) return;
    this.settings.draftText = text;
    this.settings.draftUpdatedAt = text ? Date.now() : 0;
    await this.saveSettings();
  }

  refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof DailyCaptureView) void leaf.view.rebuildUI();
    }
  }

  private updateCheckTimes: number[] = [];

  // 从 Release 附件读取 manifest.json，保证「检查到的版本」与「实际下载的文件」来自同一发布
  private async fetchLatestReleaseVersion(): Promise<string> {
    const resp = await requestUrl({
      url: `https://github.com/${UPDATE_REPO}/releases/latest/download/manifest.json`,
    });
    const latest = resp.json?.version ?? "";
    if (!latest) throw new Error("无法获取最新版本号");
    return latest;
  }

  private async sha256Hex(data: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // 读取 Release 附件 checksums.json；旧版 Release 没有该文件时返回 null（跳过校验）
  private async fetchReleaseChecksums(): Promise<Record<string, string> | null> {
    try {
      const resp = await requestUrl({
        url: `https://github.com/${UPDATE_REPO}/releases/latest/download/checksums.json`,
      });
      const data = resp.json;
      if (data && typeof data === "object") return data as Record<string, string>;
    } catch { /* 旧 Release 无 checksums.json */ }
    return null;
  }

  private isNewerVersion(latest: string, current: string): boolean {
    const a = latest.split(".").map((n) => parseInt(n) || 0);
    const b = current.split(".").map((n) => parseInt(n) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff > 0;
    }
    return false;
  }

  async checkForUpdate(): Promise<{ hasUpdate: boolean; latest: string; current: string }> {
    const now = Date.now();
    this.updateCheckTimes = this.updateCheckTimes.filter((t) => now - t < UPDATE_CHECK_INTERVAL_MS);
    if (this.updateCheckTimes.length >= 2) {
      const oldest = this.updateCheckTimes[0];
      const remain = Math.ceil((UPDATE_CHECK_INTERVAL_MS - (now - oldest)) / 1000);
      throw new Error(`请 ${remain} 秒后再试`);
    }
    this.updateCheckTimes.push(now);
    try {
      const latest = await this.fetchLatestReleaseVersion();
      return { hasUpdate: this.isNewerVersion(latest, this.manifest.version), latest, current: this.manifest.version };
    } catch (err) {
      this.updateCheckTimes.pop();
      throw err;
    }
  }

  async performUpdate(): Promise<string> {
    const latest = await this.fetchLatestReleaseVersion();
    if (!this.isNewerVersion(latest, this.manifest.version)) return latest;

    const pluginDir = this.manifest.dir;
    if (!pluginDir) throw new Error("无法确定插件目录");

    // 先把所有文件下载到内存，全部成功后再写盘，避免部分更新导致版本错位
    const requiredFiles = ["main.js", "manifest.json"];
    const optionalFiles = ["styles.css"];
    const downloaded = new Map<string, ArrayBuffer>();

    for (const filename of requiredFiles) {
      const fileResp = await requestUrl({
        url: `https://github.com/${UPDATE_REPO}/releases/latest/download/${filename}`,
      });
      if (!fileResp.arrayBuffer || fileResp.arrayBuffer.byteLength === 0) {
        throw new Error(`下载的 ${filename} 为空，已取消更新`);
      }
      downloaded.set(filename, fileResp.arrayBuffer);
    }
    for (const filename of optionalFiles) {
      try {
        const fileResp = await requestUrl({
          url: `https://github.com/${UPDATE_REPO}/releases/latest/download/${filename}`,
        });
        if (fileResp.arrayBuffer && fileResp.arrayBuffer.byteLength > 0) {
          downloaded.set(filename, fileResp.arrayBuffer);
        }
      } catch { /* styles.css 可以不存在 */ }
    }

    // SHA-256 完整性校验：Release 提供 checksums.json 时逐一比对，不匹配立即中止
    const checksums = await this.fetchReleaseChecksums();
    if (checksums) {
      for (const [filename, data] of downloaded) {
        const expected = checksums[filename]?.toLowerCase();
        if (!expected) throw new Error(`checksums.json 中缺少 ${filename} 的校验值，已取消更新`);
        const actual = await this.sha256Hex(data);
        if (actual !== expected) throw new Error(`${filename} 校验失败（文件可能已损坏或被篡改），已取消更新`);
      }
    }

    for (const [filename, data] of downloaded) {
      await this.app.vault.adapter.writeBinary(`${pluginDir}/${filename}`, data);
    }
    return latest;
  }

  async fetchReleaseNotes(version: string): Promise<string> {
    try {
      const resp = await requestUrl({
        url: `https://raw.githubusercontent.com/${UPDATE_REPO}/main/releases.json`,
      });
      const notes: Record<string, string[]> = resp.json ?? {};
      const items = notes[version];
      if (items && items.length > 0) return items.join("\n");
    } catch { /* ignore */ }
    return "";
  }
}

class MobileDailyCaptureSettingTab extends PluginSettingTab {
  plugin: MobileDailyCapturePlugin;
  private activeTab = 0;

  constructor(app: App, plugin: MobileDailyCapturePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("act-capture-settings");

    const tabs = ["配置", "更新", "支持"];
    if (this.activeTab >= tabs.length) this.activeTab = 0;
    const tabBar = containerEl.createDiv({ cls: "act-capture-settings__tab-bar" });
    const contentEl = containerEl.createDiv({ cls: "act-capture-settings__content" });

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabBar.createDiv({
        text: tabs[i],
        cls: `act-capture-settings__tab${i === this.activeTab ? " is-active" : ""}`
      });
      tab.addEventListener("click", () => {
        this.activeTab = i;
        tabBar.querySelectorAll(".act-capture-settings__tab").forEach((el, idx) => {
          el.toggleClass("is-active", idx === i);
        });
        this.renderTabContent(contentEl);
      });
    }

    this.renderTabContent(contentEl);
  }

  private renderTabContent(container: HTMLElement): void {
    container.empty();
    switch (this.activeTab) {
      case 0: this.displayConfigTab(container); break;
      case 1: this.displayUpdateSection(container); break;
      case 2: this.displaySupportSection(container); break;
    }
  }

  private displayConfigTab(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "启动" });

    new Setting(containerEl)
      .setName("手机端启动时打开")
      .setDesc("在手机端打开 Obsidian 后，自动进入闪念簿。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.openOnMobileStartup)
          .onChange(async (value) => {
            this.plugin.settings.openOnMobileStartup = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("电脑端启动时打开")
      .setDesc("在电脑端打开 Obsidian 后，自动进入闪念簿。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.openOnDesktopStartup)
          .onChange(async (value) => {
            this.plugin.settings.openOnDesktopStartup = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("保存模式")
      .setDesc("选择把闪念保存到每天的日志，或保存到一篇固定笔记。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("daily", "每日日志")
          .addOption("single", "单一笔记")
          .setValue(this.plugin.settings.storageMode)
          .onChange(async (value) => {
            this.plugin.settings.storageMode = value as StorageMode;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
            this.display();
          });
      });

    if (this.plugin.settings.storageMode === "single") {
      this.displaySingleModeSettings(containerEl);
    } else {
      this.displayDailyModeSettings(containerEl);
    }
  }

  private displaySingleModeSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "单一笔记模式" });

    new Setting(containerEl)
      .setName("项目闪念文件夹")
      .setDesc("保存模式为“单一笔记”时，首页可从这个文件夹下已有的 Markdown 笔记中选择写入目标。")
      .addSearch((search) => {
        const folders = this.plugin.getVaultFolders();
        const currentFolder = normalizeFolderPath(this.plugin.settings.projectNotesFolder);
        const listId = "act-capture-project-folder-options";
        const optionsEl = containerEl.createEl("datalist");
        optionsEl.id = listId;

        if (currentFolder && !folders.some((folder) => folder.path === currentFolder)) {
          optionsEl.createEl("option", { attr: { value: currentFolder } });
        }

        for (const folder of folders) {
          optionsEl.createEl("option", { attr: { value: folder.path } });
        }

        search.inputEl.setAttribute("list", listId);
        search.inputEl.setAttribute("autocomplete", "off");
        search
          .setPlaceholder("输入或选择项目闪念文件夹")
          .setValue(currentFolder)
          .onChange(async (value) => {
            this.plugin.settings.projectNotesFolder = normalizeFolderPath(value);
            const files = this.plugin.getProjectNoteFiles();
            if (!files.some((file) => file.path === this.plugin.settings.selectedProjectNotePath)) {
              this.plugin.settings.selectedProjectNotePath = files[0]?.path ?? "";
            }
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          });
      });

    new Setting(containerEl)
      .setName("闪念二级标题格式")
      .setDesc("用于单一笔记中每条闪念的 `##` 标题。建议使用常见格式：YYYYMMDD HH:mm。也支持 YYYY、YY、MM、DD、HH、mm，以及旧变量 {date}、{time}、{weekday} 等。")
      .addText((text) => {
        const preview = containerEl.createDiv({ cls: "act-capture-setting-preview" });
        const updatePreview = (format: string) => {
          preview.setText(`当前效果：## ${formatSingleEntryHeading(format, new Date())}`);
        };
        updatePreview(this.plugin.settings.singleEntryHeadingFormat);
        text
          .setPlaceholder("YYYYMMDD HH:mm")
          .setValue(this.plugin.settings.singleEntryHeadingFormat)
          .onChange(async (value) => {
            this.plugin.settings.singleEntryHeadingFormat = value.trim() || DEFAULT_SETTINGS.singleEntryHeadingFormat;
            updatePreview(this.plugin.settings.singleEntryHeadingFormat);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("单一笔记路径")
      .setDesc("当“项目闪念文件夹”里没有可选笔记时，闪念会保存到这篇笔记。每条闪念会用下方格式生成 `##` 二级标题。")
      .addText((text) => {
        text
          .setPlaceholder("每日闪念.md")
          .setValue(this.plugin.settings.singleNotePath)
          .onChange(async (value) => {
            this.plugin.settings.singleNotePath = normalizeNotePath(value);
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          });
      });
  }

  private displayDailyModeSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "每日日志模式" });

    new Setting(containerEl)
      .setName("日志文件夹")
      .setDesc("每日日志所在文件夹。留空则保存到 Vault 根目录。")
      .addSearch((search) => {
        const folders = this.plugin.getVaultFolders();
        const currentFolder = normalizeFolderPath(this.plugin.settings.dailyFolder);
        const listId = "act-capture-daily-folder-options";
        const optionsEl = containerEl.createEl("datalist");
        optionsEl.id = listId;

        if (currentFolder && !folders.some((folder) => folder.path === currentFolder)) {
          optionsEl.createEl("option", { attr: { value: currentFolder } });
        }

        for (const folder of folders) {
          optionsEl.createEl("option", { attr: { value: folder.path } });
        }

        search.inputEl.setAttribute("list", listId);
        search.inputEl.setAttribute("autocomplete", "off");
        search
          .setPlaceholder("输入或选择文件夹，留空为根目录")
          .setValue(currentFolder)
          .onChange(async (value) => {
            this.plugin.settings.dailyFolder = normalizeFolderPath(value);
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          });
      });

    new Setting(containerEl)
      .setName("日志文件名格式")
      .setDesc("建议使用常见格式：YYYYMMDD。也支持 YYYY、YY、MM、DD、HH、mm，以及旧变量 {date}、{weekday} 等。")
      .addText((text) => {
        const preview = containerEl.createDiv({ cls: "act-capture-setting-preview" });
        const updatePreview = (format: string) => {
          preview.setText(`当前效果：${formatDailyFileName(format, new Date())}`);
        };
        updatePreview(this.plugin.settings.dailyFileNameFormat);
        text
          .setPlaceholder("YYYYMMDD")
          .setValue(this.plugin.settings.dailyFileNameFormat)
          .onChange(async (value) => {
            this.plugin.settings.dailyFileNameFormat = value.trim() || DEFAULT_SETTINGS.dailyFileNameFormat;
            updatePreview(this.plugin.settings.dailyFileNameFormat);
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          });
      });

    new Setting(containerEl)
      .setName("保存标题")
      .setDesc("闪念保存到这个 Markdown 标题下面。可填写“每日闪念”或“## 每日闪念”。")
      .addText((text) => {
        text
          .setPlaceholder("每日闪念")
          .setValue(this.plugin.settings.thoughtHeading)
          .onChange(async (value) => {
            this.plugin.settings.thoughtHeading = cleanHeadingText(value);
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          });
      });

    new Setting(containerEl)
      .setName("日志模板路径")
      .setDesc("新建日志时使用的 Markdown 模板文件路径（相对于 Vault 根目录）。留空则自动生成基础格式。")
      .addText((text) => {
        text
          .setPlaceholder("templates/daily.md")
          .setValue(this.plugin.settings.dailyTemplatePath)
          .onChange(async (value) => {
            this.plugin.settings.dailyTemplatePath = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }

  private displayUpdateSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "act-capture-update-section" });
    const header = section.createDiv({ cls: "act-capture-update-header" });
    header.createSpan({ text: `ACT 闪念簿  v${this.plugin.manifest.version}`, cls: "act-capture-update-version" });

    const statusEl = section.createDiv({ cls: "act-capture-update-status" });
    section.createDiv({
      text: "点击「检查更新」获取最新版本。更新不会影响你的配置和数据。",
      cls: "setting-item-description"
    });

    const checkBtn = section.createEl("button", { text: "检查更新", cls: "act-capture-update-btn" });
    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = "检查中...";
      statusEl.empty();
      try {
        const result = await this.plugin.checkForUpdate();
        if (result.hasUpdate) {
          statusEl.createSpan({ text: `发现新版本 v${result.latest}` });
          const preNotes = await this.plugin.fetchReleaseNotes(result.latest);
          if (preNotes) {
            const notesEl = statusEl.createDiv({ cls: "act-capture-update-notes" });
            for (const line of preNotes.split("\n")) {
              notesEl.createDiv({ text: line });
            }
          }
          const updateBtn = statusEl.createEl("button", { text: "立即更新" });
          updateBtn.addEventListener("click", async () => {
            updateBtn.disabled = true;
            updateBtn.textContent = "下载中...";
            try {
              const version = await this.plugin.performUpdate();
              const notes = await this.plugin.fetchReleaseNotes(version);
              statusEl.empty();
              statusEl.createSpan({ text: `已更新到 v${version}，请重启 Obsidian 或重新加载插件` });
              if (notes) {
                const notesEl = statusEl.createDiv({ cls: "act-capture-update-notes" });
                notesEl.createDiv({ text: "更新内容：", attr: { style: "font-weight:600;margin-bottom:4px" } });
                for (const line of notes.split("\n")) {
                  notesEl.createDiv({ text: line });
                }
              }
              new Notice(`ACT 闪念簿已更新到 v${version}，请重新加载插件`);
            } catch (err) {
              updateBtn.disabled = false;
              updateBtn.textContent = "立即更新";
              new Notice(`更新失败：${err instanceof Error ? err.message : String(err)}`);
            }
          });
        } else {
          statusEl.createSpan({ text: "已是最新版本 ✓" });
        }
      } catch (err) {
        statusEl.createSpan({ text: `检查失败：${err instanceof Error ? err.message : String(err)}` });
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = "检查更新";
      }
    });
  }

  private displaySupportSection(containerEl: HTMLElement): void {
    const supportEl = containerEl.createDiv({ cls: "act-capture-setting-support" });

    supportEl.createEl("h3", { text: "支持与资源" });
    supportEl.createEl("p", {
      text: "公众号：kiven大汉堡（同名）",
      cls: "act-capture-setting-support__lead",
    });
    supportEl.createDiv({ text: "⬇️", cls: "act-capture-setting-support__arrow" });

    const listEl = supportEl.createDiv({ cls: "act-capture-setting-support__list" });
    listEl.createEl("p", { text: "往期个人生产力视频合集" });
    listEl.createEl("p", { text: "Obsidian 官方同步拼车：已拼 4000+" });
    listEl.createEl("p", { text: "Obsidian + AI 笔记系统教程：学员 200+" });

    const websiteEl = supportEl.createEl("p", { cls: "act-capture-setting-support__website" });
    websiteEl.appendText("详情介绍与购买，请查看个人博客：");
    const linkEl = websiteEl.createEl("a", {
      text: "kivenbig.com",
      href: "https://kivenbig.com",
    });
    linkEl.addEventListener("click", (event) => {
      event.preventDefault();
      window.open("https://kivenbig.com", "_blank");
    });
  }
}
