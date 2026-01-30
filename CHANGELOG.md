# Changelog

All notable changes to Debrief will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2024-01-30

### Added
- **TTS Narration** - OpenAI TTS integration with configurable voice and speed
- **Timed Line Highlights** - `<line:X>text</line:X>` syntax for synchronized highlights
- **Word-level Timing** - Whisper transcription for precise highlight sync
- **Voice Selection** - Choose from 6 OpenAI voices (alloy, echo, fable, onyx, nova, shimmer)
- **Speed Control** - Adjustable TTS playback speed (0.5x - 2.0x)
- **Status Bar Info** - Step info and narration shown in status bar

### Changed
- Highlights now use subtle left-border style instead of full background
- Replaced Comments API panels with lightweight inline indicators
- TTS plays immediately when navigating (TTS-first pattern)

### Removed
- Video generation (now VS Code-native playback only)
- Heavy Comments API integration

## [0.2.0] - 2024-01-27

### Added
- Timeline sidebar view with step navigation
- Review workflow (approve/flag steps)
- Follow mode toggle
- Section grouping in traces
- HTTP server for agent integration
- Diff view support

### Changed
- Improved highlight styling
- Better keyboard navigation

## [0.1.0] - 2024-01-25

### Added
- Initial release
- Basic trace file loading
- Step-by-step navigation
- Line highlighting
- File auto-opening
