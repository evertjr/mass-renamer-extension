"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const ignore_1 = __importDefault(require("ignore"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
function activate(context) {
    const disposable = vscode.commands.registerCommand("extension.massRename", (uri, uris) => {
        if (uris && uris.length > 0) {
            massRename(uris);
        }
        else if (uri) {
            massRename([uri]);
        }
    });
    context.subscriptions.push(disposable);
}
async function massRename(uris) {
    let files = [];
    for (const uri of uris) {
        const stats = await vscode.workspace.fs.stat(uri);
        if (stats.type === vscode.FileType.Directory) {
            files = files.concat(await getFilesRecursively(uri.fsPath));
        }
        else {
            files.push(uri.fsPath);
        }
    }
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
    const saveListener = vscode.workspace.onDidSaveTextDocument(async (savedDocument) => {
        if (savedDocument.uri.fsPath === tempFile) {
            const newContent = savedDocument.getText();
            const newRelativePaths = newContent
                .split("\n")
                .filter((line) => line.trim() !== "");
            if (newRelativePaths.length !== files.length) {
                vscode.window.showErrorMessage("The number of lines must match the number of files.");
                return;
            }
            const duplicates = findDuplicates(newRelativePaths);
            if (duplicates.length > 0) {
                vscode.window.showErrorMessage(`Duplicate filenames found: ${duplicates.join(", ")}`);
                return;
            }
            const newFullPaths = newRelativePaths.map((relativePath) => projectRoot ? path.join(projectRoot, relativePath) : relativePath);
            try {
                await processRenames(files, newFullPaths);
                files = newFullPaths; // Update files array with new full paths
                vscode.window.showInformationMessage("Mass rename applied!");
            }
            catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(`Error during renaming: ${error.message}`);
                }
                else {
                    vscode.window.showErrorMessage("An unknown error occurred during renaming.");
                }
            }
        }
    });
    const visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
        const isTempFileOpen = editors.some((e) => e.document.uri.fsPath === tempFile);
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
    });
}
async function getFilesRecursively(dir) {
    const ig = (0, ignore_1.default)();
    const gitignorePath = path.join(dir, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
        ig.add(gitignoreContent);
    }
    async function getFiles(currentDir) {
        const entries = await fs.promises.readdir(currentDir, {
            withFileTypes: true,
        });
        const files = await Promise.all(entries.map(async (entry) => {
            const res = path.resolve(currentDir, entry.name);
            const relativePath = path.relative(dir, res);
            if (ig.ignores(relativePath)) {
                return [];
            }
            return entry.isDirectory() ? getFiles(res) : res;
        }));
        return files.flat();
    }
    return getFiles(dir);
}
function getProjectRoot(filePath) {
    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            if (filePath.startsWith(folder.uri.fsPath)) {
                return folder.uri.fsPath;
            }
        }
    }
    return null;
}
async function createTempFile(files, uniqueSuffix) {
    let tempFilePath;
    const projectRoot = getProjectRoot(files[0]);
    if (vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length > 0) {
        tempFilePath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, `mass_rename_temp_${uniqueSuffix}.txt`);
    }
    else {
        tempFilePath = path.join(os.tmpdir(), `mass_rename_temp_${uniqueSuffix}.txt`);
    }
    const relativeFiles = files.map((file) => projectRoot ? path.relative(projectRoot, file) : file);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(tempFilePath), Buffer.from(relativeFiles.join("\n")));
    return tempFilePath;
}
async function processRenames(oldPaths, newPaths) {
    const projectRoot = getProjectRoot(oldPaths[0]);
    for (let i = 0; i < oldPaths.length; i++) {
        const oldFullPath = oldPaths[i];
        const newFullPath = projectRoot && !path.isAbsolute(newPaths[i])
            ? path.join(projectRoot, newPaths[i])
            : newPaths[i];
        if (oldFullPath !== newFullPath) {
            try {
                await vscode.workspace.fs.rename(vscode.Uri.file(oldFullPath), vscode.Uri.file(newFullPath), { overwrite: false });
            }
            catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(`Error during renaming: ${error.message}`);
                }
                else {
                    vscode.window.showErrorMessage("An unknown error occurred during renaming.");
                }
            }
        }
    }
}
function findDuplicates(array) {
    const duplicates = [];
    const seen = new Set();
    for (const item of array) {
        if (seen.has(item)) {
            duplicates.push(item);
        }
        seen.add(item);
    }
    return duplicates;
}
function deactivate() { }
//# sourceMappingURL=extension.js.map