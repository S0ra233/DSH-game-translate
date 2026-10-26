# DSH-game-translate

[中文](README.md) | English

**DSH-game-translate** is a visual, local game translation plugin for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness). Its code and resources are maintained independently in this directory, without changes to the upstream `game-translation` Core or Harness source.

Enter `/翻译` in a root conversation associated with a working directory to open a separate native translation window. The window handles **directory selection, grouped reading, aligned source/translation views, and manual text edits**. The main conversation Agent coordinates **resource extraction, translation assignments, review, and writing a separate translated game copy** through the bundled `game-translation` Skill and Core.

The plugin uses DeepSeek Harness's [Cordis-based plugin runtime](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) to separate three responsibilities:

* **Native visual window — browse, select, and edit:** select a game, switch reading groups, compare source and translation in aligned columns, and reveal an edit button on hover. The separate, non-topmost window lets you continue using the main chat.
* **DSH main/sub-Agent orchestration — translation and multiple models:** the main Agent initializes the project, reviews context and translations, and handles the final build request. It can translate directly or delegate packages to other models through DSH's native sub-Agents, with waiting and duplicate-dispatch protection. The Skill does not implement another Agent loop.
* **Deterministic translation Core and Skill:** preserve the real `Entry / Task / Scene` state, placeholder and glossary checks, and draft revisions. The workflow keeps the source game read-only, creates a separate translated copy, and reads indexed fields back for verification.

## Features and interaction

### 1. Adaptive reading groups and script navigation

* **Group adjacent Scenes:** organize small Scenes by source file, event, and explicit chapter/route boundaries while preserving each original Scene. The default soft capacity is about **140 paragraphs / 6,000 source characters**. Larger projects use progressively larger paragraph limits to try to reach **60 groups or fewer**; preserving source and branch boundaries takes priority, so this is not a hard limit for every game.
* **Navigate without changing source identities:** groups show original script labels and branch sections, such as `80:*number_of_days`, and provide expandable navigation. Grouping does not infer a linear plot. Original `Scene / Task` IDs, translation revisions, and writeback indexes stay unchanged. When you select a group for translation, the Host resolves its actual members and batches the request for the Agent.

### 2. Aligned comparison and manual edits without model calls

* **Script-style reading:** speaker names appear inline before dialogue, while narration remains separate. Read-only source and saved translation share one scroll area, with corresponding Tasks aligned to the same row height. Untranslated text leaves the translation side blank.
* **Hover to edit:** translated text, the space beside it, and the pencil button share one hover area. The button fades in with a slight upward motion and waits `160 ms` before fading out when you leave. Moving back interrupts the exit transition. System reduced-motion preferences are respected, and double-click text selection/copying remains available.
* **Save through Core checks:** click the pencil to edit a translation or switch to editing its linked speaker name. Unsaved input must be saved or cancelled before changing the edit target. Use `Ctrl+Enter` to save or `Esc` to cancel. Saves use the host communication channel and Core placeholder/rule checks, **without an LLM call or model-token usage**. An incompatible older window retains your input and asks you to update.

### 3. Native DSH sub-Agents and model protocols

* **Four supported protocols:** add or edit translation models in Settings using **OpenAI Chat Completions**, **OpenAI Responses**, **Anthropic Messages**, or **Gemini `generateContent`**. API fields use neutral focus borders and trim leading/trailing whitespace.
* **Host-managed credentials:** API keys are stored through DSH's `credentials` service, not browser `localStorage`, model configuration JSON, or the plugin's command-argument logs. Encryption at rest depends on the configured DSH credentials backend.
* **Compact diagnostics:** status and directory tools show summaries by default, with full diagnostics available explicitly. Build and verification reports can be read separately in pages, avoiding repeated diagnostic detail in the main conversation.

### 4. Native Windows window and glass material

* **Normal window ordering and reuse:** on Windows, the plugin uses an ordinary, non-topmost native window without ownership by the DSH main window. It retains the DSH icon and material styling. Other windows can come to the foreground normally; native folder dialogs use the translation window as their modal owner. Windows are reused briefly for the same conversation, and closing one does not cancel Agent tasks already dispatched. Non-Windows web entry points use browser popup/floating-window fallbacks.
* **WPF / DWM glass and white surfaces:** the native WPF / DWM material defaults to `5%` milk, `15%` soft light, `100%` edge reflection, `100%` highlight spread, and `20%` reading-surface white. Settings expose milk and soft-light adjustments. White and glass styles share the same reading-area spacing, borders, and scrollbar reservation to preserve layout and wrapping when switching.
* **Persistent typography and control details:** font, size, line spacing, column ratio, and material preferences persist. Dropdowns close on a second click, an outside click, or `Esc`, support arrow-key selection, and use interruptible entry/exit transitions. Cached text and coalesced refreshes reduce repeated work.

## Get started in five steps

The window currently uses Chinese labels. The names below identify the corresponding controls.

1. **Install the plugin:** install a release package named `dsh-game-translate-<version>.tgz`. Preserve unsaved input before upgrading, then fully exit and restart the target DSH profile. Your DSH account and main-model settings remain the ones you configure in DSH.
2. **Open the window and select a game:** enter `/翻译` in a working-directory root conversation. Choose `••• → 选择游戏目录…` to open the native Windows folder picker.
3. **Initialize and extract:** click `初始化` and confirm the model-usage notice. Progress and errors appear in the original conversation. Once resources bind to the root conversation, initialization locks to prevent duplicates. Failed attempts preserve their artifacts for repair and retry.
4. **Translate, review, and edit:** choose `翻译…`, select pending reading groups, and use the main Agent or native DSH sub-Agents with other models. The window refreshes saved translations after completion. Review both columns and use the pencil for manual edits.
5. **Write a separate game copy:** after reviewing the translations, choose `封装写回…`, select an output location, and confirm. The main Agent uses the Skill/Core to create a new, separate game copy and verify indexed text by reading it back.

> For installation, model configuration, and troubleshooting, see the [usage guide](docs/usage.en.md).

## Game engine overview

The bundled `game-translation` Core includes extraction, review, translation, and writeback routes for **six engine families**. Optional tools and dependencies must be configured as needed. This table describes implemented routes, not validation of every engine version, format, or game.

| Engine family | Implemented extraction and writeback routes | Boundaries and Agent-assisted work |
| --- | --- | --- |
| **RPG Maker**<br>XP / VX / VX Ace / MV / MZ | **MV / MZ:** database JSON, system text, and event commands, preserving control codes.<br>**XP / VX / VX Ace:** Ruby Marshal data; supported `Game.rgssad` / `Game.rgss2a` / `Game.rgss3a` archives can be unpacked into an unencrypted output copy. | Plugin-specific hardcoded text, dynamically assembled dialogue, and text in images need individual handling. The output uses unpacked resources. |
| **WOLF RPG Editor** | Optional `UberWolfCli` and `WolfTL` backends unpack supported `.wolf` archives. WolfTL's structured exports supply dialogue, speakers, and choices; supported encodings can be written to the output copy. | Modified encryption, image text, and unknown encodings need individual handling. Chinese text requires suitable in-game font configuration. Actual loading and display need verification. |
| **Unity**<br>Tables / serialized assets / code strings | **Plain and embedded tables:** JSON, CSV, TSV, TXT, and XML in StreamingAssets or extensionless TextAssets, preserving supported encodings and BOMs.<br>**Serialized assets:** optional `UnityPy` handling for TextAsset, StringTable, TMP text, Fungus, and Utage script books.<br>**Code strings:** supported IL2CPP `global-metadata.dat` v29 and Mono `ldstr` edits, local Addressables bundle synchronization, and font replacement routes. | Missing type trees may require `TypeTreeGeneratorAPI`. Remote Addressables bundles and code-literal indexes shared by multiple call sites require review. |
| **Ren'Py** | Loose `.rpy`, `.rpa` archives, and compiled `.rpyc` routes using optional `unrpa` / `unrpyc`. Extract native translation IDs and generate standard `game/tl/<language>/` translation files in the output copy. | Obfuscated scripts and dynamic strings require analysis. The normal route retains original scripts and uses Ren'Py's translation layer. Explicitly choosing the SDK fallback executes project initialization in a working copy. |
| **TyranoScript**<br>Web / Electron visual novels | Loose projects and `.ks` scripts inside standard Electron `app.asar` containers. Extract dialogue, speakers, and text parameters by script label. Write the corresponding output resources; ASAR projects are repacked and read back from the output archive. | Complex JavaScript and custom macros need separate adapters. Embedded ASAR integrity checks stop the current build for loading-path investigation; the plugin does not automatically disable checks or switch to loose loading. |
| **Godot Engine**<br>3.x / 4.x containers and scenes | Optional `GDRETools` routes for standard `.pck` and executable-embedded GDPC packages, with explicit launcher association. Scene properties, PO files, and indexed message-value edits in compiled `OptimizedTranslation` resources preserve hash-bucket identities and use UTF-8 buffers. | Unregistered dynamic strings need candidate review. Multiple-package loading, special wrappers, and private script formats need investigation. |

## Project structure and requirements

### Runtime and builds

* **Runtime:** the native Windows window targets x64 and requires .NET Framework 4.8 and WebView2 Runtime. The plugin targets DSH `0.2.1-rc.3`, Cordis `~4.0.5`, Node.js `24.9+`, and Python `3.10+`; other versions have not been validated.
* **Prebuilt distribution:** release packages named `dsh-game-translate-<version>.tgz` contain the compiled frontend. Installation does not require another frontend build. For local development, run `npm ci` and `npm run build`.

### Modules

```text
src/
  index.js                Plugin Host entry and command registration
  models.js               Translation model routes for four API protocols
  delegation.js           Native DSH sub-Agent dispatch, waiting, and deduplication
  client/                 Window UI source; distributed entry: dist/client.js
python/
  bridge.py               Python Worker communication entry
  operations.py           Plugin operations, session scope, and Core calls
  vendor/                 Pinned game-translation Core and engine reference docs
skills/
  game-translation/       Agent instructions and engine/host references
native/wpf/               Windows window, material, and local communication host
docs/                     Installation and usage guides
```

## Validation and distribution

* **Validation scope:** protocol checks use local simulated responses, and delegation checks use a simulated DSH sub-Agent service. Isolated sample games exercise real Core extraction, submission, writeback, and readback. Frontend checks use an offscreen browser; native-host checks use no-window diagnostic paths. These automated checks use no real API keys, paid model calls, or automatic game launches. Actual desktop appearance, window switching, provider connectivity, and in-game behavior require user testing.
* **Installation and package scope:** save unsent edits and back up important configuration before upgrading. Retain your existing `dataDirectory` to reuse bindings and translations. Release packages include the compiled UI and Windows host, but not optional engine tools, a Python interpreter, or WebView2 Runtime. Public files exclude `node_modules`, research copies, test output, model settings, API credentials, personal games, and conversation data.
* **Third-party licenses:** see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for sources and license information.
