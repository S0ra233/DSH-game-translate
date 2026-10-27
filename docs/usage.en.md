# Installation and usage

[README](../README.en.md) | [中文说明](使用说明.md)

The plugin targets DSH `0.2.1-rc.3` and Cordis `~4.0.5`. Opening the translation window and saving model settings do not start model requests. Initialization and translation are performed by the original conversation Agent and can consume model tokens.

## Install

Use the plugin manager for your DSH profile, or the DSH CLI. Replace `<version>`, the package path, and `desktop` with the package and profile you actually use:

If you used the former `dsh-translate` package, disable or remove it before enabling `dsh-game-translate` to avoid duplicate commands. Reuse the existing `dataDirectory` to retain projects and model records.

```powershell
dsh plugin --profile desktop add 'C:/Plugins/DSH-game-translate/dsh-game-translate-<version>.tgz'
```

Save unsent edits before upgrading, then fully exit and reopen DSH. Keep the existing `dataDirectory` to reuse bindings and translations. Do not install a separate global DSH just to run this command if your desktop installation already provides plugin management.

Release packages contain the compiled frontend and Windows host. For a source checkout, run:

```powershell
npm ci
npm run build
npm run pack:local
```

The source snapshot also includes the native host sources. To rebuild the included host on Windows, use `native/wpf/Build.ps1`. This is separate from the frontend build.

## Runtime and configuration

Node.js `24.9+` and Python `3.10+` are required. The native Windows window targets x64 and uses .NET Framework 4.8 and an installed WebView2 Runtime. Optional engine backends are configured separately; Python alone does not provide every engine's extraction tools.

The default Python command is `python`. If needed, override the plugin's configuration in your profile patch. These are example paths; use your own locations. DSH replaces the configuration row, so retain every setting you need:

```yaml
- id: dsh-game-translate
  config:
    pythonExecutable: 'C:/Python311/python.exe'
    dataDirectory: 'C:/TranslationData/DSH-game-translate'
    allowedGameRoots: []
    allowedWorkRoots: []
    timeoutMs: 900000
    cancelGraceMs: 5000
```

The default data directory is `~/.dsh/plugin-data/DSH-game-translate` (under `DSH_HOME` when set), independent of the installed package and version. An explicit `dataDirectory` always takes precedence and is retained across updates. On first use, any surviving legacy package-local `.local` state is copied without deleting the source; existing default state is never overwritten. Multiple legacy stores require an explicit choice. Before upgrading an older version, preserve its original data directory so a package manager cannot remove the only copy with the old package. The optional `nativeWindowIcon` setting can point to the icon in your own DSH installation.

The plugin needs the tools, commands, skills, llm, and credentials services. Native delegation also needs subagents; the main Agent can translate without delegation.

## Open and initialize

After locating a search result, the complete current reading group remains reachable in both directions. Larger groups load around the viewport, with the full source outline still available for direct navigation. Reading continues after the search pane is closed. Saves, Agent updates, and page loading preserve the reading position; explicit search navigation centres the target. Unsaved edits prevent replacement or eviction of their paragraph.

Search preparation runs in the background. New input replaces obsolete queries while reusing an ongoing build for the same project. The versioned search cache can be rebuilt independently of bindings, translations, manual-edit markers, and model configuration.

The 18px open arc beside Search shows task progress. Hover for a summary, or click to pin the detail card and switch between the entire project and the current reading group. Clicking a status opens Search with that filter. Click the arc again, click outside, or press Esc to close the card. Its material follows the white/glass setting.

Only Core tasks marked PROCESSED count as completed; review, untranslated, and error states remain separate. Totals include independent speaker-name tasks and can differ from the merged paragraphs on screen. Manual edits are provenance markers within those states. Progress uses cached reading-group counts and updates after saves and Agent changes. Hovering and opening the card neither scan text nor call a model. Increase/decrease animations stop when settled and respect reduced-motion preferences.

Enter `/翻译` in a root conversation with a working directory. The window currently uses Chinese labels. Bare `/translation` also opens the window; parameterized commands such as `/translation status` remain available.

Use `••• → 选择游戏目录…` to select a folder. Switching an existing binding shows a warning first. Cancelling either the warning or picker retains the original binding. Choosing a different game clears the current binding and requires initialization; old workspaces and translations remain on disk.

Click `初始化` and confirm the model-usage notice. This queues a request in the same Agent conversation; queued does not mean the model has started. Extraction progress and errors appear in that conversation. Initialization locks only after actual resources are registered or a Core project is established. Failed attempts preserve artifacts for repair and retry.

You can also ask the Agent in chat to switch games. That route keeps the old binding until new resources succeed. Games outside the allowed workspace need authorization through the folder picker or the real user command `/translation allow-game`; model tools cannot grant themselves access.

## Read, translate, and edit

The Scene selector presents reading groups, with original labels and branch sections retained inside each group. Left is read-only source, right is the saved Core translation. Untranslated cells are blank. Speaker Tasks are displayed inline with matching dialogue, while their original identities remain available for writeback.

Choose `翻译…` to select pending groups and use the main Agent or native DSH sub-Agents. Other models can be configured in Settings. The main Agent reads real packages, dispatches work, reviews results, and submits complete drafts. Temporary model output is not displayed as a saved translation.

Hover over translated text and click the pencil to edit it. Double-click remains text selection. The editor can switch to the linked speaker name after current input is saved or cancelled. `Ctrl+Enter` saves; `Esc` cancels. Source text stays read-only. Manual saves use Core checks and revision guards without model calls; errors retain the input rather than overwriting a newer translation.

While editing, automatic refresh, group switching, and More actions are paused. Refresh resumes when editing ends. The window otherwise refreshes on relevant Agent status changes, focus, and opening More, rather than continuously polling while idle.

## Model settings

In `设置 → 翻译模型`, enter a display name, protocol, API base URL, API key, and model ID. Click a saved model name to edit it; an empty key retains its existing credential. Saving does not perform a paid connectivity test.

| Protocol | Example base URL |
| --- | --- |
| OpenAI Chat Completions | `https://api.example.com/v1` |
| OpenAI Responses | `https://api.example.com/v1` |
| Anthropic Messages | `https://api.anthropic.com` |
| Gemini generateContent | `https://generativelanguage.googleapis.com/v1beta` |

Use the compatible service's own HTTP(S) base URL. Keep keys in the dedicated key field, not URL parameters. DSH credentials stores keys; they are not returned in model lists or saved in browser preferences/model JSON. Encryption at rest depends on the DSH credential backend.

Advanced context/output limits are configurable budgets, not provider guarantees. Defaults are 65,536 / 8,192. The service must support the selected protocol and DSH's tool/structured-output requirements. Unknown pricing uses a zero-cost placeholder, which does not mean the service is free.

Dropdowns toggle on repeated clicks, close on outside click or `Esc`, and support arrow keys. Text inputs use neutral focus borders and trim leading/trailing whitespace.

## Appearance and windows

Choose white or glass styling, system or serif font, 12–24 px text, three line spacings, and column ratios from 35:65 to 65:35. Glass exposes milk and soft light, defaulting to 5% and 15%, within a 0–80% range. Edge reflection, highlight spread, and reading-area white remain fixed at 100%, 100%, and 20%.

Native preferences are stored in `dataDirectory/native-appearance.json`; browser fallbacks use localStorage. Project binding is managed by the Host. Closing a window does not cancel dispatched Agent work. At most one hidden native window is kept briefly for reuse, and it is released after the keepalive timeout, DSH exit, or plugin unload. Hidden windows stop refreshing and animating.

## Build and verify

After reviewing translations, choose `封装写回…`, select an output parent directory, and confirm the proposed new child directory. Consent is tied to that project, binding version, and output location. The main Agent builds a separate copy through Core and reads back indexed values. It does not overwrite the source game or automatically launch the output.

A matching readback does not verify complete extraction, translation quality, fonts, layout, or actual gameplay. Validate those in the game separately.

## Errors and recovery

Read initialization errors in the original conversation. `translation_status` and `translation_job` default to summaries; use `detail="full"` for diagnostic details and log paths. `translation_read_report` reads allowlisted reports from a ready project in pages. Some engines do not create every report.

If a consumed initialization turn is interrupted, status handling associates the failure with its request ID. An unrelated turn does not clear a queued request. After a restart or uncertain outcome, inspect jobs and artifacts before retrying. Use `translation_abandon_initialization` only after deciding to end the pending attempt; do not run competing operations on the same work directory.

Native sub-Agent completion is delivered by DSH. Waiting can time out without cancelling work; `accepted` or `running` does not mean failure. Duplicate dispatch protection is process-local. After a plugin restart, check native sub-Agent history and saved drafts before dispatching again.

When reporting a problem, include DSH version, the step that failed, relevant UI/chat errors, and protocol type. Redact keys and private game content. Automated checks use isolated fixtures, simulated model responses, offscreen UI, and no-window host paths; actual desktop appearance, providers, and game runtime remain user acceptance checks.
