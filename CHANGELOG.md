# Change Log

All notable changes to the "mass-renamer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.7] - 2026-02-11

- Fixed context menu not appearing when selecting multiple files — previously only showed for folders.
- Fixed case-only renaming on Windows & macOS (e.g., `File.txt` → `file.txt`) no longer fails with a "File exists" error. (PR #5 by @ngmarchant)

## [0.0.6] - 2025-08-11

- Windows: Hardened workspace path check to be case-insensitive, preventing false negatives that could skip safe deletion of emptied folders when casing differs (e.g., drive letter or mixed-case roots).

## [0.0.5] - 2025-08-11

- Added opt-in setting `massRenamer.deleteEmptyFolders` to automatically delete folders that become empty after mass renaming. Only folders touched by the extension are considered, and deletion occurs only when the folder is empty.

## [0.0.4] - 2025-04-07

- Fixed duplicate file entries on Windows by adding a deduplication step that normalizes and filters file paths before processing.
- Added case-insensitive normalization on Windows to properly handle overlapping folder and file selections.

## [Unreleased]

- Added compatibility with more versions of Visual Studio Code
- Initial release
