const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const IGNORED_DIRS = new Set([
  ".git",
  ".idea",
  ".vs",
  "Binaries",
  "DerivedDataCache",
  "Intermediate",
  "Saved",
  "node_modules",
  "__ExternalActors__",
  "__ExternalObjects__",
]);

const TOP_LEVEL_SCAN_DIRS = new Set(["Config", "Source", "Plugins"]);
const ALLOWED_EXTENSIONS = new Set([
  ".uproject",
  ".uplugin",
  ".ini",
  ".cs",
  ".h",
  ".cpp",
  ".hpp",
  ".c",
  ".cc",
  ".sln",
  ".vcxproj",
  ".vcxproj.filters",
]);
const TEXT_SEARCH_EXTENSIONS = new Set([
  ".uproject",
  ".uplugin",
  ".ini",
  ".cs",
  ".h",
  ".cpp",
  ".hpp",
  ".c",
  ".cc",
  ".sln",
  ".vcxproj",
  ".vcxproj.filters",
]);

function shouldScanDirectory(entryName, relativePath) {
  if (IGNORED_DIRS.has(entryName)) {
    return false;
  }

  if (!relativePath || relativePath === ".") {
    return true;
  }

  const topLevel = relativePath.split(path.sep)[0];
  return TOP_LEVEL_SCAN_DIRS.has(topLevel);
}

function shouldIncludeFile(relativePath, absolutePath) {
  const ext = path.extname(absolutePath).toLowerCase();

  if (ALLOWED_EXTENSIONS.has(ext)) {
    return true;
  }

  // Keep root-level project descriptors even if extension rules change later.
  return /^[^\\\/]+\.(uproject|uplugin)$/i.test(relativePath);
}

function normalizeOldProjectName(value) {
  return (value || "").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchTokens(oldProjectName) {
  const normalized = normalizeOldProjectName(oldProjectName);
  const tokenLower = normalized.toLowerCase();
  const macroBase = normalized.replace(/[^a-zA-Z0-9_]/g, "").toUpperCase();
  const apiMacro = macroBase ? `${macroBase}_API` : "";

  return {
    normalized,
    tokenLower,
    apiMacro,
    apiMacroLower: apiMacro.toLowerCase(),
  };
}

function isTextSearchFile(absolutePath) {
  const ext = path.extname(absolutePath).toLowerCase();
  return TEXT_SEARCH_EXTENSIONS.has(ext);
}

function countMatches(haystack, needle, caseInsensitive = false) {
  if (!needle) {
    return 0;
  }
  const flags = caseInsensitive ? "gi" : "g";
  const regex = new RegExp(escapeRegExp(needle), flags);
  const matches = haystack.match(regex);
  return matches ? matches.length : 0;
}

function replaceAllCaseInsensitive(haystack, needle, replacement) {
  if (!needle) {
    return haystack;
  }
  const regex = new RegExp(escapeRegExp(needle), "gi");
  return haystack.replace(regex, replacement);
}

function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/\//g, "\\")
    .replace(/^\\+|\\+$/g, "");
}

function getMatchDepth(relativePath, entries) {
  const normalizedPath = normalizeRelativePath(relativePath).toLowerCase();
  if (!normalizedPath) {
    return -1;
  }

  let bestDepth = -1;
  for (const entry of entries) {
    const normalizedEntry = normalizeRelativePath(entry).toLowerCase();
    if (!normalizedEntry) {
      continue;
    }
    if (
      normalizedPath === normalizedEntry ||
      normalizedPath.startsWith(`${normalizedEntry}\\`)
    ) {
      bestDepth = Math.max(bestDepth, normalizedEntry.length);
    }
  }
  return bestDepth;
}

function isExcludedPath(relativePath, excludedEntries, includedEntries = []) {
  const excludeDepth = getMatchDepth(relativePath, excludedEntries);
  const includeDepth = getMatchDepth(relativePath, includedEntries);

  if (excludeDepth < 0 && includeDepth < 0) {
    return false;
  }
  if (excludeDepth === includeDepth) {
    return false;
  }
  return excludeDepth > includeDepth;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buildCoreRedirectLines(oldProjectName, newProjectName) {
  const oldName = normalizeOldProjectName(oldProjectName);
  const newName = normalizeOldProjectName(newProjectName);
  if (!oldName || !newName || oldName === newName) {
    return [];
  }

  return [
    `+ClassRedirects=(OldName="/Script/${oldName}",NewName="/Script/${newName}",MatchSubstring=true)`,
    `+StructRedirects=(OldName="/Script/${oldName}",NewName="/Script/${newName}",MatchSubstring=true)`,
    `+EnumRedirects=(OldName="/Script/${oldName}",NewName="/Script/${newName}",MatchSubstring=true)`,
    `+FunctionRedirects=(OldName="/Script/${oldName}",NewName="/Script/${newName}",MatchSubstring=true)`,
    `+PackageRedirects=(OldName="/Script/${oldName}",NewName="/Script/${newName}",MatchSubstring=true)`,
  ];
}

async function detectOldProjectName(projectRoot, uprojectPath, files) {
  const fileNameCandidate = path.basename(uprojectPath, ".uproject");
  const sourceDir = path.join(projectRoot, "Source");

  try {
    const sourceEntries = await fs.readdir(sourceDir, { withFileTypes: true });
    const sourceModuleDirs = sourceEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."));

    if (sourceModuleDirs.includes(fileNameCandidate)) {
      return fileNameCandidate;
    }

    if (sourceModuleDirs.length === 1) {
      return sourceModuleDirs[0];
    }
  } catch {
    // Source directory may not exist in blueprint-only projects.
  }

  const targetCandidates = new Set();
  for (const file of files) {
    if (!file.startsWith(`Source${path.sep}`)) {
      continue;
    }
    if (!file.endsWith(".Target.cs")) {
      continue;
    }
    const targetName = path.basename(file, ".Target.cs");
    if (targetName.endsWith("Editor")) {
      targetCandidates.add(targetName.slice(0, -"Editor".length));
    } else {
      targetCandidates.add(targetName);
    }
  }

  if (targetCandidates.size === 1) {
    return Array.from(targetCandidates)[0];
  }

  return fileNameCandidate;
}

async function filterFilesByOldProjectName(rootDir, files, oldProjectName) {
  const { normalized, tokenLower, apiMacro, apiMacroLower } = buildSearchTokens(
    oldProjectName
  );

  if (!normalized) {
    return files;
  }

  const matchedFiles = [];

  for (const relativePath of files) {
    const absolutePath = path.join(rootDir, relativePath);
    const relativeLower = relativePath.toLowerCase();

    if (relativeLower.includes(tokenLower)) {
      matchedFiles.push(relativePath);
      continue;
    }

    if (!isTextSearchFile(absolutePath)) {
      continue;
    }

    try {
      const content = await fs.readFile(absolutePath, "utf8");
      const contentLower = content.toLowerCase();
      if (contentLower.includes(tokenLower)) {
        matchedFiles.push(relativePath);
        continue;
      }
      if (apiMacro && contentLower.includes(apiMacroLower)) {
        matchedFiles.push(relativePath);
      }
    } catch {
      // Ignore unreadable files and continue scanning.
    }
  }

  matchedFiles.sort((a, b) => a.localeCompare(b));
  return matchedFiles;
}

async function buildRenamePreview(
  rootDir,
  files,
  oldProjectName,
  newProjectName,
  includeCoreRedirects,
  excludedPaths = [],
  includedPaths = [],
  excludedCoreRedirectLines = []
) {
  const oldTokens = buildSearchTokens(oldProjectName);
  const newTokens = buildSearchTokens(newProjectName);

  if (!oldTokens.normalized || !newTokens.normalized) {
    return {
      oldProjectName: oldTokens.normalized,
      newProjectName: newTokens.normalized,
      summary: {
        totalFilesScanned: files.length,
        filesWithChanges: 0,
        pathRenames: 0,
        contentEdits: 0,
        totalReplacements: 0,
      },
      pathRenames: [],
      contentEdits: [],
    };
  }

  const pathRenames = [];
  const contentEdits = [];
  let skippedByBlacklist = 0;

  for (const relativePath of files) {
    if (isExcludedPath(relativePath, excludedPaths, includedPaths)) {
      skippedByBlacklist += 1;
      continue;
    }

    const absolutePath = path.join(rootDir, relativePath);

    const pathNameHits = countMatches(relativePath, oldTokens.normalized, true);
    const pathApiHits = oldTokens.apiMacro
      ? countMatches(relativePath, oldTokens.apiMacro, true)
      : 0;
    const pathHits = pathNameHits + pathApiHits;

    if (pathHits > 0) {
      let newPath = relativePath;
      if (oldTokens.apiMacro && newTokens.apiMacro) {
        newPath = replaceAllCaseInsensitive(
          newPath,
          oldTokens.apiMacro,
          newTokens.apiMacro
        );
      }
      newPath = replaceAllCaseInsensitive(
        newPath,
        oldTokens.normalized,
        newTokens.normalized
      );

      pathRenames.push({
        file: relativePath,
        newFile: newPath,
        replacements: pathHits,
      });
    }

    if (!isTextSearchFile(absolutePath)) {
      continue;
    }

    try {
      const content = await fs.readFile(absolutePath, "utf8");
      const apiHits = oldTokens.apiMacro
        ? countMatches(content, oldTokens.apiMacro, true)
        : 0;
      const withoutApi = oldTokens.apiMacro
        ? replaceAllCaseInsensitive(content, oldTokens.apiMacro, "")
        : content;
      const nameHits = countMatches(withoutApi, oldTokens.normalized, true);
      const totalHits = nameHits + apiHits;

      if (totalHits > 0) {
        contentEdits.push({
          file: relativePath,
          oldNameHits: nameHits,
          oldApiHits: apiHits,
          replacements: totalHits,
        });
      }
    } catch {
      // Skip files that can't be decoded as text.
    }
  }

  pathRenames.sort((a, b) => a.file.localeCompare(b.file));
  contentEdits.sort((a, b) => a.file.localeCompare(b.file));

  const filesWithChanges = new Set([
    ...pathRenames.map((x) => x.file),
    ...contentEdits.map((x) => x.file),
  ]).size;

  const totalReplacements =
    pathRenames.reduce((sum, item) => sum + item.replacements, 0) +
    contentEdits.reduce((sum, item) => sum + item.replacements, 0);

  let coreRedirectLines = includeCoreRedirects
    ? buildCoreRedirectLines(oldTokens.normalized, newTokens.normalized)
    : [];
  const excludedRedirectSet = new Set((excludedCoreRedirectLines || []).map((x) => String(x)));
  const skippedCoreRedirectLines = coreRedirectLines.filter((line) =>
    excludedRedirectSet.has(line)
  ).length;
  coreRedirectLines = coreRedirectLines.filter((line) => !excludedRedirectSet.has(line));

  return {
    oldProjectName: oldTokens.normalized,
    newProjectName: newTokens.normalized,
      summary: {
        totalFilesScanned: files.length,
        filesWithChanges,
        pathRenames: pathRenames.length,
        contentEdits: contentEdits.length,
      totalReplacements,
        skippedByBlacklist,
        skippedCoreRedirectLines,
      },
    pathRenames,
    contentEdits,
    coreRedirects: {
      enabled: !!includeCoreRedirects,
      targetFile: "Config/DefaultEngine.ini",
      section: "[CoreRedirects]",
      lines: coreRedirectLines,
    },
  };
}

async function applyRenamePlan(rootDir, preview) {
  const logs = [];
  const pathRenamed = [];
  const contentUpdated = [];
  const errors = [];
  let redirectsAdded = 0;

  const oldTokens = buildSearchTokens(preview.oldProjectName);
  const newTokens = buildSearchTokens(preview.newProjectName);

  const sortedPathRenames = [...preview.pathRenames].sort(
    (a, b) => b.file.length - a.file.length
  );
  const renameMap = new Map();

  for (const renameEntry of sortedPathRenames) {
    const oldAbs = path.join(rootDir, renameEntry.file);
    const newAbs = path.join(rootDir, renameEntry.newFile);

    if (oldAbs === newAbs) {
      logs.push({
        level: "warn",
        message: `Skip path rename (same path): ${renameEntry.file}`,
      });
      continue;
    }

    if (!(await pathExists(oldAbs))) {
      logs.push({
        level: "warn",
        message: `Source file not found, skipped rename: ${renameEntry.file}`,
      });
      continue;
    }

    if (await pathExists(newAbs)) {
      errors.push(`Target already exists: ${renameEntry.newFile}`);
      logs.push({
        level: "error",
        message: `Target already exists, rename skipped: ${renameEntry.newFile}`,
      });
      continue;
    }

    try {
      await fs.mkdir(path.dirname(newAbs), { recursive: true });
      await fs.rename(oldAbs, newAbs);
      renameMap.set(renameEntry.file, renameEntry.newFile);
      pathRenamed.push({
        from: renameEntry.file,
        to: renameEntry.newFile,
      });
      logs.push({
        level: "success",
        message: `Renamed path: ${renameEntry.file} -> ${renameEntry.newFile}`,
      });
    } catch (error) {
      errors.push(`Rename failed: ${renameEntry.file} -> ${renameEntry.newFile}`);
      logs.push({
        level: "error",
        message: `Rename failed: ${renameEntry.file} -> ${renameEntry.newFile} (${error.message})`,
      });
    }
  }

  for (const editEntry of preview.contentEdits) {
    const actualRelativePath = renameMap.get(editEntry.file) || editEntry.file;
    const absolutePath = path.join(rootDir, actualRelativePath);

    if (!(await pathExists(absolutePath))) {
      logs.push({
        level: "warn",
        message: `Content edit skipped, file not found: ${actualRelativePath}`,
      });
      continue;
    }

    try {
      const originalText = await fs.readFile(absolutePath, "utf8");
      let updatedText = originalText;
      if (oldTokens.apiMacro && newTokens.apiMacro) {
        updatedText = replaceAllCaseInsensitive(
          updatedText,
          oldTokens.apiMacro,
          newTokens.apiMacro
        );
      }
      updatedText = replaceAllCaseInsensitive(
        updatedText,
        oldTokens.normalized,
        newTokens.normalized
      );

      if (updatedText === originalText) {
        logs.push({
          level: "warn",
          message: `No text changes detected after re-check: ${actualRelativePath}`,
        });
        continue;
      }

      await fs.writeFile(absolutePath, updatedText, "utf8");
      contentUpdated.push({
        file: actualRelativePath,
      });
      logs.push({
        level: "success",
        message: `Updated content: ${actualRelativePath}`,
      });
    } catch (error) {
      errors.push(`Content update failed: ${actualRelativePath}`);
      logs.push({
        level: "error",
        message: `Content update failed: ${actualRelativePath} (${error.message})`,
      });
    }
  }

  if (preview.coreRedirects?.enabled && preview.coreRedirects.lines?.length) {
    const redirectFileRel = preview.coreRedirects.targetFile || "Config/DefaultEngine.ini";
    const redirectFileAbs = path.join(rootDir, redirectFileRel);

    try {
      await fs.mkdir(path.dirname(redirectFileAbs), { recursive: true });
      let iniContent = "";
      if (await pathExists(redirectFileAbs)) {
        iniContent = await fs.readFile(redirectFileAbs, "utf8");
      }

      const missingLines = preview.coreRedirects.lines.filter(
        (line) => !iniContent.includes(line)
      );

      if (missingLines.length > 0) {
        const hasTrailingNewline = iniContent.endsWith("\n") || iniContent.length === 0;
        const prefix = hasTrailingNewline ? "" : "\n";
        const block = `${prefix}[CoreRedirects]\n${missingLines.join("\n")}\n`;
        await fs.appendFile(redirectFileAbs, block, "utf8");
        redirectsAdded = missingLines.length;
        logs.push({
          level: "success",
          message: `Added ${missingLines.length} CoreRedirects lines to ${redirectFileRel}`,
        });
      } else {
        logs.push({
          level: "warn",
          message: `CoreRedirects already present in ${redirectFileRel}`,
        });
      }
    } catch (error) {
      errors.push(`CoreRedirects update failed: ${redirectFileRel}`);
      logs.push({
        level: "error",
        message: `CoreRedirects update failed: ${redirectFileRel} (${error.message})`,
      });
    }
  }

  return {
    pathRenamed,
    contentUpdated,
    redirectsAdded,
    errors,
    logs,
    summary: {
      pathRenamed: pathRenamed.length,
      contentUpdated: contentUpdated.length,
      redirectsAdded,
      errors: errors.length,
      totalLogEntries: logs.length,
      skippedByBlacklist: preview.summary?.skippedByBlacklist || 0,
    },
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    titleBarStyle: "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

async function collectProjectFiles(rootDir) {
  const files = [];
  let visitedDirs = 0;

  async function walk(currentDir) {
    visitedDirs += 1;
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const currentRelative = path.relative(rootDir, currentDir);

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath);

      if (entry.isDirectory()) {
        if (!shouldScanDirectory(entry.name, relativePath)) {
          continue;
        }
        await walk(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        if (
          currentRelative === "" ||
          TOP_LEVEL_SCAN_DIRS.has(relativePath.split(path.sep)[0])
        ) {
          if (shouldIncludeFile(relativePath, absolutePath)) {
            files.push(relativePath);
          }
        }
      }
    }
  }

  await walk(rootDir);
  files.sort((a, b) => a.localeCompare(b));

  return {
    rootDir,
    files,
    visitedDirs,
    totalFiles: files.length,
  };
}

ipcMain.handle("project:pick-uproject", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select Unreal Project",
    properties: ["openFile"],
    filters: [{ name: "Unreal Project", extensions: ["uproject"] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const uprojectPath = result.filePaths[0];
  const projectRoot = path.dirname(uprojectPath);
  const projectData = await collectProjectFiles(projectRoot);
  const oldProjectName = await detectOldProjectName(
    projectRoot,
    uprojectPath,
    projectData.files
  );
  const matchedFiles = await filterFilesByOldProjectName(
    projectRoot,
    projectData.files,
    oldProjectName
  );

  return {
    canceled: false,
    uprojectPath,
    oldProjectName,
    rootDir: projectData.rootDir,
    visitedDirs: projectData.visitedDirs,
    scannedFiles: projectData.totalFiles,
    totalFiles: matchedFiles.length,
    files: matchedFiles,
  };
});

ipcMain.handle("project:rescan", async (_event, payload) => {
  const uprojectPath = payload?.uprojectPath;
  if (!uprojectPath) {
    throw new Error("uprojectPath is required for rescan.");
  }

  const projectRoot = path.dirname(uprojectPath);
  const projectData = await collectProjectFiles(projectRoot);
  const detectedName = await detectOldProjectName(
    projectRoot,
    uprojectPath,
    projectData.files
  );
  const oldProjectName = normalizeOldProjectName(payload?.oldProjectName) || detectedName;
  const matchedFiles = await filterFilesByOldProjectName(
    projectRoot,
    projectData.files,
    oldProjectName
  );

  return {
    uprojectPath,
    oldProjectName,
    rootDir: projectData.rootDir,
    visitedDirs: projectData.visitedDirs,
    scannedFiles: projectData.totalFiles,
    totalFiles: matchedFiles.length,
    files: matchedFiles,
  };
});

ipcMain.handle("project:preview-rename", async (_event, payload) => {
  const uprojectPath = payload?.uprojectPath;
  if (!uprojectPath) {
    throw new Error("uprojectPath is required for preview.");
  }

  const oldProjectName = normalizeOldProjectName(payload?.oldProjectName);
  const newProjectName = normalizeOldProjectName(payload?.newProjectName);
  const includeCoreRedirects = !!payload?.includeCoreRedirects;
  const excludedPaths = Array.isArray(payload?.excludedPaths)
    ? payload.excludedPaths
    : [];
  const includedPaths = Array.isArray(payload?.includedPaths)
    ? payload.includedPaths
    : [];
  const excludedCoreRedirectLines = Array.isArray(payload?.excludedCoreRedirectLines)
    ? payload.excludedCoreRedirectLines
    : [];
  if (!oldProjectName || !newProjectName) {
    throw new Error("Both oldProjectName and newProjectName are required.");
  }

  const projectRoot = path.dirname(uprojectPath);
  const projectData = await collectProjectFiles(projectRoot);
  const preview = await buildRenamePreview(
    projectRoot,
    projectData.files,
    oldProjectName,
    newProjectName,
    includeCoreRedirects,
    excludedPaths,
    includedPaths,
    excludedCoreRedirectLines
  );

  return {
    uprojectPath,
    rootDir: projectRoot,
    ...preview,
  };
});

ipcMain.handle("project:apply-rename", async (_event, payload) => {
  const uprojectPath = payload?.uprojectPath;
  if (!uprojectPath) {
    throw new Error("uprojectPath is required for apply.");
  }

  const oldProjectName = normalizeOldProjectName(payload?.oldProjectName);
  const newProjectName = normalizeOldProjectName(payload?.newProjectName);
  const includeCoreRedirects = !!payload?.includeCoreRedirects;
  const excludedPaths = Array.isArray(payload?.excludedPaths)
    ? payload.excludedPaths
    : [];
  const includedPaths = Array.isArray(payload?.includedPaths)
    ? payload.includedPaths
    : [];
  const excludedCoreRedirectLines = Array.isArray(payload?.excludedCoreRedirectLines)
    ? payload.excludedCoreRedirectLines
    : [];

  if (!oldProjectName || !newProjectName) {
    throw new Error("Both oldProjectName and newProjectName are required for apply.");
  }

  const projectRoot = path.dirname(uprojectPath);
  const projectData = await collectProjectFiles(projectRoot);
  const preview = await buildRenamePreview(
    projectRoot,
    projectData.files,
    oldProjectName,
    newProjectName,
    includeCoreRedirects,
    excludedPaths,
    includedPaths,
    excludedCoreRedirectLines
  );
  const applyResult = await applyRenamePlan(projectRoot, preview);

  return {
    uprojectPath,
    rootDir: projectRoot,
    oldProjectName,
    newProjectName,
    includeCoreRedirects,
    ...applyResult,
  };
});

ipcMain.handle("app:open-external", async (_event, payload) => {
  const url = String(payload?.url || "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only http(s) URLs are allowed.");
  }
  await shell.openExternal(url);
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
