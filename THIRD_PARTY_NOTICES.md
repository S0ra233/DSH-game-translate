# Third-party sources

`python/vendor/game_translation`, `python/vendor/process_support`, the engine documentation under `python/vendor/tools`, and the original `skills/game-translation` resources are a source snapshot of [S0ra233/Game-translation-skill](https://github.com/S0ra233/Game-translation-skill), copied from the user's local project on 2026-10-24. Translation repository HEAD: `b44bcc51952eef1875f8b7afefe2df9189cf753b`. The original MIT license is retained at `python/vendor/LICENSE`. From 0.3.8 the Skill entry is DSH-specific; the prior portable entry is preserved as `SKILL-portable.md`. New host guidance is identified there and in `references/dsh.md`; the original Core is unchanged.

`research/upstream` contains selected DeepSeek Harness reference material at commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`, with its MIT license. It is excluded from the distributed package.

External engine binaries, Python interpreters, model credentials, user conversations, games and private runtime data are not bundled. Optional engine libraries and tools retain their own licenses and must be supplied separately when needed.

The public source preparation includes the matching upstream helper sources under `python/vendor/tools`: `godot/gdre_bridge.gd`, `renpy/read_rpyc.py`, and the Unity Mono/Addressables helper sources and build files. These come from the same Core commit above; external GDRETools, unrpa/unrpyc, dnlib, Addressables dependencies and compiled helper binaries are not bundled. Including these sources does not constitute runtime validation of those optional routes.

The 0.2 UI uses the host's shared React/ReactDOM modules. DSH llm-pi-ai and pi-ai protocol SDKs are npm dependencies, not copied provider implementations; their licenses are distributed with those packages. The plugin uses the public provider factories and the pinned DSH PiAiAdapter contract. Gemini is an additional route configured by this plugin, not a claim that DSH's stock manual protocol table includes Gemini.

The 0.2.1 Client also bundles the pure DSH Typert remote-info helper and Zod. Their MIT license texts are retained in licenses/.

The 0.2.2 native-window renderer bundles React, ReactDOM, and Scheduler; their MIT licenses are retained in licenses/. PySide6/QtWebEngine and QtWebChannel are provided by the user Python runtime, not redistributed by this package. The DSH icon is read from the installed desktop resources at runtime.

The 0.3.1 window reuses that React UI over a native WPF/DWM material host. It redistributes Microsoft.Web.WebView2 SDK 1.0.3296.44 Core/WPF assemblies and the x64 loader, under the Microsoft license retained in `licenses/WebView2-LICENSE.txt`; accompanying notices are in `licenses/WebView2-NOTICE.txt`. The separately installed WebView2 Runtime is required and is not bundled. The host only loads the two packaged UI assets and blocks external navigation, downloads and web network access; model traffic remains with DSH.
