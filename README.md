# Veltriva Browser

> **Browse freely. Remember effortlessly.**

Veltriva is a local-first, Chromium-powered desktop browser that intelligently manages inactive tabs, preserves browsing context, and makes previously visited pages instantly searchable.

**Status: Phase 0.** The architecture is approved and technical spikes are in progress. There is no runnable browser yet.

## Why

Some people keep 50 or 100 tabs open because closing one feels like losing it. Veltriva is built for them. It manages tabs *for* you, and it keeps everything findable:

- **Tabs you stop using move out of the way:** Tabs → Sleeping → Archive. Inactivity is measured in *your* browsing time, so a weekend away never empties your workspace.
- **Inactive pages are unloaded to free memory**, and their back/forward history is kept.
- **Pages that might hold unsaved work are left alone**, for example ones playing audio, sharing your camera, or declaring unsaved changes.
- **Every tab stays in a private, local, searchable memory**, one keystroke away (Ctrl+Shift+K).
- **Nothing leaves your machine:** no telemetry, no cloud, no remote search suggestions.

## Principles

- **Velocity:** fast browsing with intelligent resource management.
- **Retrieval:** effortlessly rediscover previously visited websites.
- **Continuity:** resume browsing sessions without losing context.

## Documentation

- [Technical assessment and architecture proposal](docs/architecture/technical-assessment.md)
- [Architecture decision records](docs/adr/README.md)
- [Phase 0 spike reports](docs/spikes/README.md)

## Platform and stack

Windows 10/11 x64. Electron (`BaseWindow` + `WebContentsView`), TypeScript, React, SQLite with FTS5.

## License

[MIT](LICENSE). Dependency licenses will be reviewed before the first release.
