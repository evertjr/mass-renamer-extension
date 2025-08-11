import * as crypto from "crypto";
import * as fs from "fs";
import ignore from "ignore";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "extension.massRename",
    (uri: vscode.Uri, uris: vscode.Uri[]) => {
      if (uris && uris.length > 0) {
        massRename(uris);
      } else if (uri) {
        massRename([uri]);
      }
    }
  );

  context.subscriptions.push(disposable);
}

async function massRename(uris: vscode.Uri[]) {
  let files: string[] = [];
  for (const uri of uris) {
    const stats = await vscode.workspace.fs.stat(uri);
    if (stats.type === vscode.FileType.Directory) {
      files = files.concat(await getFilesRecursively(uri.fsPath));
    } else {
      files.push(uri.fsPath);
    }
  }

  // Deduplicate file paths to avoid processing duplicates.
  // On Windows, paths are case-insensitive so we convert to lower case.
  const seen = new Set<string>();
  files = files.filter((f) => {
    const normalized =
      process.platform === "win32"
        ? path.normalize(f).toLowerCase()
        : path.normalize(f);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });

  if (files.length === 0) {
    vscode.window.showWarningMessage("No files selected for renaming.");
    return;
  }

  const uniqueSuffix = crypto.randomBytes(4).toString("hex");
  const tempFile = await createTempFile(files, uniqueSuffix);
  const document = await vscode.workspace.openTextDocument(tempFile);
  await vscode.window.showTextDocument(document);

  let tempFileOpen = true;
  const projectRoot = getProjectRoot(files[0]);

  const watcher = vscode.workspace.createFileSystemWatcher(tempFile);

  const changeListener = watcher.onDidChange(async () => {
    // Do nothing on change, wait for save
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument(
    async (savedDocument) => {
      if (savedDocument.uri.fsPath === tempFile) {
        const newContent = savedDocument.getText();
        const newRelativePaths = newContent
          .split("\n")
          .filter((line) => line.trim() !== "");

        if (newRelativePaths.length !== files.length) {
          vscode.window.showErrorMessage(
            "The number of lines must match the number of files."
          );
          return;
        }

        const duplicates = findDuplicates(newRelativePaths);
        if (duplicates.length > 0) {
          vscode.window.showErrorMessage(
            `Duplicate filenames found: ${duplicates.join(", ")}`
          );
          return;
        }

        const newFullPaths = newRelativePaths.map((relativePath) =>
          projectRoot ? path.join(projectRoot, relativePath) : relativePath
        );

        try {
          const movedFromDirs = await processRenames(files, newFullPaths);
          files = newFullPaths; // Update files array with new full paths
          await deleteEmptyFoldersIfEnabled(movedFromDirs);
          vscode.window.showInformationMessage("Mass rename applied!");
        } catch (error) {
          if (error instanceof Error) {
            vscode.window.showErrorMessage(
              `Error during renaming: ${error.message}`
            );
          } else {
            vscode.window.showErrorMessage(
              "An unknown error occurred during renaming."
            );
          }
        }
      }
    }
  );

  const visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors(
    async (editors) => {
      const isTempFileOpen = editors.some(
        (e) => e.document.uri.fsPath === tempFile
      );
      if (!(!isTempFileOpen && tempFileOpen)) {
        return;
      }
      tempFileOpen = false;
      watcher.dispose();
      changeListener.dispose();
      saveListener.dispose();
      visibleEditorsListener.dispose();
      await vscode.workspace.fs.delete(vscode.Uri.file(tempFile));
      vscode.window.showInformationMessage("Mass rename completed.");
    }
  );
}

async function getFilesRecursively(dir: string): Promise<string[]> {
  const ig = ignore();
  const gitignorePath = path.join(dir, ".gitignore");

  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    ig.add(gitignoreContent);
  }

  async function getFiles(currentDir: string): Promise<string[]> {
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const res = path.resolve(currentDir, entry.name);
        const relativePath = path.relative(dir, res);

        if (ig.ignores(relativePath)) {
          return [];
        }

        return entry.isDirectory() ? getFiles(res) : res;
      })
    );
    return files.flat();
  }

  return getFiles(dir);
}

function getProjectRoot(filePath: string): string | null {
  if (vscode.workspace.workspaceFolders) {
    for (const folder of vscode.workspace.workspaceFolders) {
      if (filePath.startsWith(folder.uri.fsPath)) {
        return folder.uri.fsPath;
      }
    }
  }
  return null;
}

async function createTempFile(
  files: string[],
  uniqueSuffix: string
): Promise<string> {
  let tempFilePath: string;
  const projectRoot = getProjectRoot(files[0]);

  if (
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders.length > 0
  ) {
    tempFilePath = path.join(
      vscode.workspace.workspaceFolders[0].uri.fsPath,
      `mass_rename_temp_${uniqueSuffix}.txt`
    );
  } else {
    tempFilePath = path.join(
      os.tmpdir(),
      `mass_rename_temp_${uniqueSuffix}.txt`
    );
  }

  const relativeFiles = files.map((file) =>
    projectRoot ? path.relative(projectRoot, file) : file
  );

  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(tempFilePath),
    new TextEncoder().encode(relativeFiles.join("\n"))
  );

  return tempFilePath;
}

async function processRenames(
  oldPaths: string[],
  newPaths: string[]
): Promise<Set<string>> {
  const projectRoot = getProjectRoot(oldPaths[0]);
  const movedFromDirs = new Set<string>();

  for (let i = 0; i < oldPaths.length; i++) {
    const oldFullPath = oldPaths[i];
    const newFullPath =
      projectRoot && !path.isAbsolute(newPaths[i])
        ? path.join(projectRoot, newPaths[i])
        : newPaths[i];

    if (oldFullPath !== newFullPath) {
      try {
        await vscode.workspace.fs.rename(
          vscode.Uri.file(oldFullPath),
          vscode.Uri.file(newFullPath),
          { overwrite: false }
        );

        const oldDir = path.dirname(oldFullPath);
        const newDir = path.dirname(newFullPath);
        // Only consider directories where the file was moved to a different folder
        if (!pathsEqual(oldDir, newDir)) {
          movedFromDirs.add(oldDir);
        }
      } catch (error) {
        if (error instanceof Error) {
          vscode.window.showErrorMessage(
            `Error during renaming: ${error.message}`
          );
        } else {
          vscode.window.showErrorMessage(
            "An unknown error occurred during renaming."
          );
        }
      }
    }
  }

  return movedFromDirs;
}

function pathsEqual(a: string, b: string): boolean {
  const na = process.platform === "win32" ? a.toLowerCase() : a;
  const nb = process.platform === "win32" ? b.toLowerCase() : b;
  return path.normalize(na) === path.normalize(nb);
}

async function deleteEmptyFoldersIfEnabled(dirs: Set<string>) {
  const cfg = vscode.workspace.getConfiguration("massRenamer");
  const shouldDelete = cfg.get<boolean>("deleteEmptyFolders", false);
  if (!shouldDelete || dirs.size === 0) {
    return;
  }

  for (const dir of dirs) {
    try {
      if (!(await isWithinWorkspace(dir))) {
        continue;
      }
      if (await isDirectoryEmpty(dir)) {
        await vscode.workspace.fs.delete(vscode.Uri.file(dir), {
          recursive: false,
        });
      }
    } catch (e) {
      // Best-effort; ignore failures and keep going
    }
  }
}

async function isDirectoryEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.length === 0;
  } catch {
    return false;
  }
}

async function isWithinWorkspace(fsPath: string): Promise<boolean> {
  if (!vscode.workspace.workspaceFolders) {
    return false;
  }
  let normalized = path.normalize(fsPath);
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  for (const folder of vscode.workspace.workspaceFolders) {
    let root = path.normalize(folder.uri.fsPath);
    if (process.platform === "win32") {
      root = root.toLowerCase();
    }
    if (
      normalized === root ||
      (normalized.startsWith(root + path.sep) &&
        normalized.length > root.length)
    ) {
      return true;
    }
  }
  return false;
}

function findDuplicates(array: string[]): string[] {
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const item of array) {
    if (seen.has(item)) {
      duplicates.push(item);
    }
    seen.add(item);
  }
  return duplicates;
}

export function deactivate() {}
