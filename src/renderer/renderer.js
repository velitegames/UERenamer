const pickBtn = document.getElementById("pickBtn");
const statusEl = document.getElementById("status");
const projectRootEl = document.getElementById("projectRoot");
const scannedFilesEl = document.getElementById("scannedFiles");
const totalFilesEl = document.getElementById("totalFiles");
const visitedDirsEl = document.getElementById("visitedDirs");
const excludedCountEl = document.getElementById("excludedCount");
const fileListEl = document.getElementById("fileList");
const matchedPanelEl = document.getElementById("matchedPanel");
const oldNamePanelEl = document.getElementById("oldNamePanel");
const newNamePanelEl = document.getElementById("newNamePanel");
const oldNameInputEl = document.getElementById("oldNameInput");
const newNameInputEl = document.getElementById("newNameInput");
const newNameValidationEl = document.getElementById("newNameValidation");
const previewWrapEl = document.getElementById("previewWrap");
const previewBtnEl = document.getElementById("previewBtn");
const coreRedirectsInputEl = document.getElementById("coreRedirectsInput");
const rescanBtn = document.getElementById("rescanBtn");
const previewPanelEl = document.getElementById("previewPanel");
const previewOldNameEl = document.getElementById("previewOldName");
const previewNewNameEl = document.getElementById("previewNewName");
const previewFilesWithChangesEl = document.getElementById("previewFilesWithChanges");
const previewTotalReplacementsEl = document.getElementById("previewTotalReplacements");
const previewPathRenamesEl = document.getElementById("previewPathRenames");
const previewContentEditsEl = document.getElementById("previewContentEdits");
const previewSkippedByBlacklistEl = document.getElementById("previewSkippedByBlacklist");
const previewSkippedRedirectLinesEl = document.getElementById("previewSkippedRedirectLines");
const previewPathListEl = document.getElementById("previewPathList");
const previewContentListEl = document.getElementById("previewContentList");
const toggleMatchedBtnEl = document.getElementById("toggleMatchedBtn");
const coreRedirectsPanelEl = document.getElementById("coreRedirectsPanel");
const coreRedirectsTargetFileEl = document.getElementById("coreRedirectsTargetFile");
const coreRedirectsSectionEl = document.getElementById("coreRedirectsSection");
const coreRedirectsListEl = document.getElementById("coreRedirectsList");
const applyBtnEl = document.getElementById("applyBtn");
const applyModalBackdropEl = document.getElementById("applyModalBackdrop");
const applyCancelBtnEl = document.getElementById("applyCancelBtn");
const applyConfirmBtnEl = document.getElementById("applyConfirmBtn");
const resultModalBackdropEl = document.getElementById("resultModalBackdrop");
const resultCloseBtnEl = document.getElementById("resultCloseBtn");
const resultPathRenamedEl = document.getElementById("resultPathRenamed");
const resultContentUpdatedEl = document.getElementById("resultContentUpdated");
const resultRedirectsAddedEl = document.getElementById("resultRedirectsAdded");
const resultErrorsEl = document.getElementById("resultErrors");
const resultLogListEl = document.getElementById("resultLogList");
const telegramBtnEl = document.getElementById("telegramBtn");

let selectedUprojectPath = "";
let baselineOldName = "";
let applyConfirmCountdown = 0;
let applyTimerId = null;
let hasPreviewReady = false;
let currentMatchedFiles = [];
let currentPreviewData = null;
const excludedPaths = new Set();
const includedPaths = new Set();
const excludedCoreRedirectLines = new Set();

function setStatus(message) {
  statusEl.textContent = message;
}

function normalizePath(value) {
  return String(value || "").replace(/\//g, "\\").replace(/^\\+|\\+$/g, "");
}

function getMatchDepth(pathValue, entries) {
  const normalized = normalizePath(pathValue).toLowerCase();
  if (!normalized) {
    return -1;
  }

  let bestDepth = -1;
  for (const entry of entries) {
    const normalizedEntry = normalizePath(entry).toLowerCase();
    if (!normalizedEntry) {
      continue;
    }
    if (
      normalized === normalizedEntry ||
      normalized.startsWith(`${normalizedEntry}\\`)
    ) {
      bestDepth = Math.max(bestDepth, normalizedEntry.length);
    }
  }

  return bestDepth;
}

function isPathExcluded(relativePath) {
  const excludeDepth = getMatchDepth(relativePath, excludedPaths);
  const includeDepth = getMatchDepth(relativePath, includedPaths);

  if (excludeDepth < 0 && includeDepth < 0) {
    return false;
  }
  if (excludeDepth === includeDepth) {
    return false;
  }
  return excludeDepth > includeDepth;
}

function updateExcludedCountUI() {
  excludedCountEl.textContent = String(excludedPaths.size);
}

function updateRescanButtonState() {
  const currentValue = oldNameInputEl.value.trim();
  rescanBtn.disabled = currentValue.length === 0 || currentValue === baselineOldName;
}

function validateNewProjectName(newName, oldName) {
  const rawValue = newName || "";
  const value = rawValue.trim();
  const oldValue = (oldName || "").trim();

  if (!rawValue) {
    return { valid: false, reason: "", state: "empty" };
  }

  if (!value) {
    return {
      valid: false,
      reason: "Project name cannot be empty or whitespace only.",
      state: "error",
    };
  }

  if (rawValue !== value) {
    return {
      valid: false,
      reason: "Project name cannot start or end with spaces.",
      state: "error",
    };
  }

  if (/\s/.test(value)) {
    return {
      valid: false,
      reason: "Project name cannot contain spaces.",
      state: "error",
    };
  }

  if (/[^A-Za-z0-9_]/.test(value)) {
    return {
      valid: false,
      reason: "Use only Latin letters, numbers, and underscore (_).",
      state: "error",
    };
  }

  if (value === oldValue) {
    return {
      valid: false,
      reason: "New project name must be different from old project name.",
      state: "error",
    };
  }

  return { valid: true, reason: "Name is valid.", state: "success" };
}

function updateNewNameValidationUI() {
  const validation = validateNewProjectName(
    newNameInputEl.value,
    oldNameInputEl.value
  );
  const hasInput = newNameInputEl.value.length > 0;

  previewWrapEl.classList.toggle("hidden", !hasInput);
  previewBtnEl.disabled = !validation.valid;

  if (!hasInput || validation.state === "empty") {
    newNameValidationEl.classList.add("hidden");
    newNameValidationEl.classList.remove("error", "success");
    newNameValidationEl.textContent = "";
    return;
  }

  newNameValidationEl.classList.remove("hidden");
  newNameValidationEl.classList.toggle("error", validation.state === "error");
  newNameValidationEl.classList.toggle("success", validation.state === "success");
  newNameValidationEl.textContent = validation.reason;
}

function setMatchedListVisibility(isVisible) {
  fileListEl.classList.toggle("hidden", !isVisible);
  toggleMatchedBtnEl.setAttribute("aria-expanded", isVisible ? "true" : "false");
  toggleMatchedBtnEl.title = isVisible ? "Hide matched list" : "Show matched list";
}

function syncMatchedToggleVisibility() {
  toggleMatchedBtnEl.classList.toggle("hidden", !selectedUprojectPath);
}

function clearPreviewUI() {
  const wasMatchedListVisible = !fileListEl.classList.contains("hidden");
  previewPanelEl.classList.add("hidden");
  closeApplyModal();
  closeResultModal();
  currentPreviewData = null;
  hasPreviewReady = false;
  applyBtnEl.disabled = true;
  if (selectedUprojectPath) {
    setMatchedListVisibility(wasMatchedListVisible);
  } else {
    fileListEl.classList.add("hidden");
  }
  syncMatchedToggleVisibility();
  previewOldNameEl.textContent = "-";
  previewNewNameEl.textContent = "-";
  previewFilesWithChangesEl.textContent = "0";
  previewTotalReplacementsEl.textContent = "0";
  previewPathRenamesEl.textContent = "0";
  previewContentEditsEl.textContent = "0";
  previewSkippedByBlacklistEl.textContent = "0";
  previewSkippedRedirectLinesEl.textContent = "0";
  previewPathListEl.innerHTML = "";
  previewContentListEl.innerHTML = "";
  coreRedirectsPanelEl.classList.add("hidden");
  coreRedirectsTargetFileEl.textContent = "Config/DefaultEngine.ini";
  coreRedirectsSectionEl.textContent = "[CoreRedirects]";
  coreRedirectsListEl.innerHTML = "";
}

function renderPreviewList(containerEl, items, emptyMessage, mapFn, limit) {
  containerEl.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = emptyMessage;
    containerEl.appendChild(li);
    return;
  }

  const visibleItems = typeof limit === "number" ? items.slice(0, limit) : items;
  for (const item of visibleItems) {
    const li = document.createElement("li");
    const mapped = mapFn(item);

    const row = document.createElement("div");
    row.className = "file-row";

    const label = document.createElement("span");
    label.className = "file-label";
    label.textContent = mapped.label;
    if (mapped.path && isPathExcluded(mapped.path)) {
      label.classList.add("excluded-path");
    }
    if (mapped.coreRedirectLine && excludedCoreRedirectLines.has(mapped.coreRedirectLine)) {
      label.classList.add("excluded-path");
    }
    row.appendChild(label);

    if (mapped.path || mapped.coreRedirectLine) {
      const actions = document.createElement("div");
      actions.className = "row-actions";

      if (mapped.path) {
        const fileBtn = document.createElement("button");
        fileBtn.className = "btn-inline";
        fileBtn.dataset.excludePath = normalizePath(mapped.path);
        fileBtn.textContent = isPathExcluded(mapped.path) ? "Include file" : "Exclude file";
        actions.appendChild(fileBtn);

        if (mapped.allowExcludeDir && mapped.path.includes("\\")) {
          const dirPath = normalizePath(mapped.path.substring(0, mapped.path.lastIndexOf("\\")));
          if (dirPath) {
            const dirBtn = document.createElement("button");
            dirBtn.className = "btn-inline";
            dirBtn.dataset.excludePath = dirPath;
            dirBtn.textContent = isPathExcluded(dirPath) ? "Include dir" : "Exclude dir";
            actions.appendChild(dirBtn);
          }
        }
      }

      if (mapped.coreRedirectLine) {
        const lineBtn = document.createElement("button");
        lineBtn.className = "btn-inline";
        lineBtn.dataset.excludeRedirectLine = mapped.coreRedirectLine;
        lineBtn.textContent = excludedCoreRedirectLines.has(mapped.coreRedirectLine)
          ? "Include line"
          : "Exclude line";
        actions.appendChild(lineBtn);
      }

      row.appendChild(actions);
    }

    li.appendChild(row);
    containerEl.appendChild(li);
  }
}

function renderPreview(preview) {
  currentPreviewData = preview;
  previewOldNameEl.textContent = preview.oldProjectName;
  previewNewNameEl.textContent = preview.newProjectName;
  previewFilesWithChangesEl.textContent = String(preview.summary.filesWithChanges);
  previewTotalReplacementsEl.textContent = String(preview.summary.totalReplacements);
  previewPathRenamesEl.textContent = String(preview.summary.pathRenames);
  previewContentEditsEl.textContent = String(preview.summary.contentEdits);
  previewSkippedByBlacklistEl.textContent = String(preview.summary.skippedByBlacklist || 0);
  previewSkippedRedirectLinesEl.textContent = String(
    preview.summary.skippedCoreRedirectLines || 0
  );

  renderPreviewList(
    previewPathListEl,
    preview.pathRenames,
    "No path rename candidates.",
    (entry) => ({
      label: `${entry.file} -> ${entry.newFile} (x${entry.replacements})`,
      path: entry.file,
      allowExcludeDir: true,
    })
  );
  renderPreviewList(
    previewContentListEl,
    preview.contentEdits,
    "No content edit candidates.",
    (entry) => ({
      label: `${entry.file} (name: ${entry.oldNameHits}, api: ${entry.oldApiHits}, total: ${entry.replacements})`,
      path: entry.file,
      allowExcludeDir: true,
    })
  );

  if (preview.coreRedirects?.enabled) {
    coreRedirectsTargetFileEl.textContent =
      preview.coreRedirects.targetFile || "Config/DefaultEngine.ini";
    coreRedirectsSectionEl.textContent = preview.coreRedirects.section || "[CoreRedirects]";
    renderPreviewList(
      coreRedirectsListEl,
      preview.coreRedirects.lines || [],
      "No redirect lines generated.",
      (entry) => ({
        label: entry,
        coreRedirectLine: entry,
      })
    );
    coreRedirectsPanelEl.classList.remove("hidden");
  } else {
    coreRedirectsPanelEl.classList.add("hidden");
  }

  previewPanelEl.classList.remove("hidden");
  hasPreviewReady = true;
  applyBtnEl.disabled = false;
}

function stopApplyCountdown() {
  if (applyTimerId) {
    clearInterval(applyTimerId);
    applyTimerId = null;
  }
}

function updateApplyConfirmButton() {
  if (applyConfirmCountdown > 0) {
    applyConfirmBtnEl.disabled = true;
    applyConfirmBtnEl.textContent = `Confirm (${applyConfirmCountdown}s)`;
  } else {
    applyConfirmBtnEl.disabled = false;
    applyConfirmBtnEl.textContent = "Confirm";
  }
}

function openApplyModal() {
  stopApplyCountdown();
  applyConfirmCountdown = 10;
  updateApplyConfirmButton();
  applyModalBackdropEl.classList.remove("hidden");

  applyTimerId = setInterval(() => {
    applyConfirmCountdown -= 1;
    if (applyConfirmCountdown <= 0) {
      applyConfirmCountdown = 0;
      stopApplyCountdown();
    }
    updateApplyConfirmButton();
  }, 1000);
}

function closeApplyModal() {
  stopApplyCountdown();
  applyModalBackdropEl.classList.add("hidden");
}

function closeResultModal() {
  resultModalBackdropEl.classList.add("hidden");
}

function renderApplyResult(result) {
  resultPathRenamedEl.textContent = String(result.summary?.pathRenamed ?? 0);
  resultContentUpdatedEl.textContent = String(result.summary?.contentUpdated ?? 0);
  resultRedirectsAddedEl.textContent = String(result.summary?.redirectsAdded ?? 0);
  resultErrorsEl.textContent = String(result.summary?.errors ?? 0);

  resultLogListEl.innerHTML = "";
  const logs = result.logs || [];
  if (logs.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No log entries.";
    resultLogListEl.appendChild(li);
  } else {
    for (const entry of logs) {
      const li = document.createElement("li");
      li.classList.add(`log-${entry.level || "warn"}`);
      const level = (entry.level || "info").toUpperCase();
      li.textContent = `[${level}] ${entry.message}`;
      resultLogListEl.appendChild(li);
    }
  }

  resultModalBackdropEl.classList.remove("hidden");
}

function renderProjectData(result) {
  selectedUprojectPath = result.uprojectPath;
  baselineOldName = (result.oldProjectName || "").trim();
  currentMatchedFiles = Array.isArray(result.files) ? result.files : [];
  excludedPaths.clear();
  includedPaths.clear();
  excludedCoreRedirectLines.clear();
  updateExcludedCountUI();

  oldNameInputEl.value = baselineOldName;
  newNameInputEl.value = "";
  oldNamePanelEl.classList.remove("hidden");
  newNamePanelEl.classList.remove("hidden");
  updateRescanButtonState();
  updateNewNameValidationUI();
  clearPreviewUI();

  projectRootEl.textContent = result.rootDir;
  scannedFilesEl.textContent = String(result.scannedFiles ?? 0);
  totalFilesEl.textContent = String(result.totalFiles);
  visitedDirsEl.textContent = String(result.visitedDirs);
  renderFiles(currentMatchedFiles);
  fileListEl.classList.remove("hidden");
  syncMatchedToggleVisibility();
}

function renderFiles(files) {
  fileListEl.innerHTML = "";
  const visibleFiles = files;

  if (visibleFiles.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No files found =< \nWhy?";
    fileListEl.appendChild(li);
    return;
  }

  for (const file of visibleFiles) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "file-row";

    const label = document.createElement("span");
    label.className = "file-label";
    label.textContent = file;
    if (isPathExcluded(file)) {
      label.classList.add("excluded-path");
    }
    row.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const fileBtn = document.createElement("button");
    fileBtn.className = "btn-inline";
    fileBtn.dataset.excludePath = normalizePath(file);
    fileBtn.textContent = isPathExcluded(file) ? "Include file" : "Exclude file";
    actions.appendChild(fileBtn);

    if (file.includes("\\")) {
      const dirPath = normalizePath(file.substring(0, file.lastIndexOf("\\")));
      if (dirPath) {
        const dirBtn = document.createElement("button");
        dirBtn.className = "btn-inline";
        dirBtn.dataset.excludePath = dirPath;
        dirBtn.textContent = isPathExcluded(dirPath) ? "Include dir" : "Exclude dir";
        actions.appendChild(dirBtn);
      }
    }

    row.appendChild(actions);
    li.appendChild(row);
    fileListEl.appendChild(li);
  }
}

function toggleBlacklistPath(pathValue) {
  const normalized = normalizePath(pathValue);
  if (!normalized) {
    return;
  }

  if (isPathExcluded(normalized)) {
    excludedPaths.delete(normalized);
    includedPaths.add(normalized);
  } else {
    excludedPaths.add(normalized);
    includedPaths.delete(normalized);
  }
  updateExcludedCountUI();
  renderFiles(currentMatchedFiles);
  if (currentPreviewData) {
    renderPreview(currentPreviewData);
  }
}

function toggleCoreRedirectLine(lineValue) {
  const line = String(lineValue || "");
  if (!line) {
    return;
  }
  if (excludedCoreRedirectLines.has(line)) {
    excludedCoreRedirectLines.delete(line);
  } else {
    excludedCoreRedirectLines.add(line);
  }
  if (currentPreviewData) {
    renderPreview(currentPreviewData);
  }
}

pickBtn.addEventListener("click", async () => {
  pickBtn.disabled = true;
  setStatus("Selecting project...");

  try {
    const result = await window.projectApi.pickUproject();

    if (result.canceled) {
      selectedUprojectPath = "";
      syncMatchedToggleVisibility();
      setStatus("Selection canceled.");
      return;
    }

    renderProjectData(result);
    setStatus(
      `Loaded: ${result.uprojectPath} | matched ${result.totalFiles} of ${result.scannedFiles}`
    );
  } catch (error) {
    console.error(error);
    setStatus("Failed to read project files.");
  } finally {
    pickBtn.disabled = false;
  }
});

oldNameInputEl.addEventListener("input", () => {
  updateRescanButtonState();
  updateNewNameValidationUI();
  clearPreviewUI();
});

newNameInputEl.addEventListener("input", () => {
  updateNewNameValidationUI();
  clearPreviewUI();
});

previewBtnEl.addEventListener("click", async () => {
  const validation = validateNewProjectName(newNameInputEl.value, oldNameInputEl.value);
  if (!validation.valid) {
    updateNewNameValidationUI();
    return;
  }

  previewBtnEl.disabled = true;
  rescanBtn.disabled = true;
  pickBtn.disabled = true;
  setStatus("Building preview...");

  try {
    const preview = await window.projectApi.previewRename({
      uprojectPath: selectedUprojectPath,
      oldProjectName: oldNameInputEl.value,
      newProjectName: newNameInputEl.value,
      includeCoreRedirects: coreRedirectsInputEl.checked,
      excludedPaths: Array.from(excludedPaths),
      includedPaths: Array.from(includedPaths),
      excludedCoreRedirectLines: Array.from(excludedCoreRedirectLines),
    });
    renderPreview(preview);
    setMatchedListVisibility(false);
    previewPanelEl.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(
      `Preview ready: ${preview.summary.filesWithChanges} files, ${preview.summary.totalReplacements} replacements`
    );
  } catch (error) {
    console.error(error);
    setStatus("Preview failed.");
    updateNewNameValidationUI();
  } finally {
    pickBtn.disabled = false;
    updateRescanButtonState();
    updateNewNameValidationUI();
  }
});

toggleMatchedBtnEl.addEventListener("click", () => {
  const isCurrentlyVisible = !fileListEl.classList.contains("hidden");
  setMatchedListVisibility(!isCurrentlyVisible);
});

applyBtnEl.addEventListener("click", () => {
  if (!hasPreviewReady) {
    setStatus("Run Preview first, then apply changes.");
    return;
  }
  openApplyModal();
});

applyCancelBtnEl.addEventListener("click", () => {
  closeApplyModal();
});

applyConfirmBtnEl.addEventListener("click", () => {
  if (applyConfirmCountdown > 0) {
    return;
  }

  void (async () => {
    closeApplyModal();
    setStatus("Applying rename changes...");

    pickBtn.disabled = true;
    rescanBtn.disabled = true;
    previewBtnEl.disabled = true;
    applyBtnEl.disabled = true;

    try {
      const result = await window.projectApi.applyRename({
        uprojectPath: selectedUprojectPath,
        oldProjectName: oldNameInputEl.value,
        newProjectName: newNameInputEl.value,
        includeCoreRedirects: coreRedirectsInputEl.checked,
        excludedPaths: Array.from(excludedPaths),
        includedPaths: Array.from(includedPaths),
        excludedCoreRedirectLines: Array.from(excludedCoreRedirectLines),
      });

      renderApplyResult(result);
      const errorCount = result.summary?.errors ?? 0;
      if (errorCount > 0) {
        setStatus(
          `Apply finished with ${errorCount} error(s). Check Apply Results log.`
        );
      } else {
        setStatus("Apply finished successfully. Check Apply Results for details.");
      }
    } catch (error) {
      console.error(error);
      setStatus("Apply failed.");
    } finally {
      pickBtn.disabled = false;
      updateRescanButtonState();
      updateNewNameValidationUI();
      applyBtnEl.disabled = false;
    }
  })();
});

applyModalBackdropEl.addEventListener("click", (event) => {
  if (event.target === applyModalBackdropEl) {
    closeApplyModal();
  }
});

resultCloseBtnEl.addEventListener("click", () => {
  closeResultModal();
});

resultModalBackdropEl.addEventListener("click", (event) => {
  if (event.target === resultModalBackdropEl) {
    closeResultModal();
  }
});

fileListEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-exclude-path]");
  if (!button) {
    return;
  }
  toggleBlacklistPath(button.dataset.excludePath);
});

previewPathListEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-exclude-path]");
  if (!button) {
    return;
  }
  toggleBlacklistPath(button.dataset.excludePath);
});

previewContentListEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-exclude-path]");
  if (!button) {
    return;
  }
  toggleBlacklistPath(button.dataset.excludePath);
});

coreRedirectsListEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-exclude-redirect-line]");
  if (!button) {
    return;
  }
  toggleCoreRedirectLine(button.dataset.excludeRedirectLine);
});

rescanBtn.addEventListener("click", async () => {
  if (!selectedUprojectPath) {
    return;
  }

  const oldProjectName = oldNameInputEl.value.trim();
  if (!oldProjectName) {
    return;
  }

  rescanBtn.disabled = true;
  pickBtn.disabled = true;
  setStatus("Rescanning with updated old project name...");

  try {
    const result = await window.projectApi.rescanProject({
      uprojectPath: selectedUprojectPath,
      oldProjectName,
    });

    renderProjectData(result);
    setStatus(
      `Rescan complete. Old name: ${result.oldProjectName} | matched ${result.totalFiles} of ${result.scannedFiles}`
    );
  } catch (error) {
    console.error(error);
    setStatus("Rescan failed.");
    updateRescanButtonState();
  } finally {
    pickBtn.disabled = false;
  }
});

telegramBtnEl.addEventListener("click", async () => {
  try {
    await window.projectApi.openExternal("https://t.me/velitelink");
  } catch (error) {
    console.error(error);
    setStatus("Failed to open Telegram link.");
  }
});

updateExcludedCountUI();
syncMatchedToggleVisibility();
