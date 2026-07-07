> [!WARNING]
> This started as a side project that blew up; not production grade and you'll hit bugs, but hopefully it covers what you need. **This project will soon be archived.**


<p align="center">
  <img src="public/openscreen.png" alt="OpenScreen Logo" width="64" />
  <br />
  <br />
	<a href="https://trendshift.io/repositories/17427" target="_blank"><img src="https://trendshift.io/api/badge/repositories/17427" alt="siddharthvaddem%2Fopenscreen | Trendshift" style="width: 256px; height: 64px;" width="256" height="64"/></a>


  </a>
</p>

# <p align="center">OpenScreen</p>

<p align="center"><strong>OpenScreen is your free, open-source alternative to Screen Studio.</strong></p>

## ✨ What's new in this fork (v1.7.0)

This fork builds on upstream OpenScreen with on-device narration + captioning, cloud AI script polishing, and macOS packaging fixes:

- **AI script polish (cloud, bring-your-own-key)** — rewrite your recorded narration with OpenAI: pick a tone and each transcript segment is polished in place, so your on-device voiceover, script-linked captions, and timeline follow automatically. Per-segment revert and full undo are supported. Your API key is stored encrypted on-device and only the segment text is sent — never audio or video.
- **AI voiceover** — generate natural-sounding narration from a script, entirely on-device (Kokoro-82M). No cloud, works offline; with per-segment audition, timeline-synced preview, and export.
- **AI doc export (cloud, bring-your-own-key)** — turn a recording into a Trupeer-style visual walkthrough: interaction-anchored steps with composited screenshots, written by a multimodal OpenAI call (vision + transcript) and saved as a self-contained HTML file (plus PDF). Shares your encrypted OpenAI key with script polish; only the transcript and screenshots are sent — never audio or video.
- **Script-linked captions** — on-screen captions derive from the voiceover script and stay in sync with the narration, styled by one global caption style.
- **macOS fixes** — the app now shows in the Dock and owns the menu bar (previously ran as an accessory app with neither), and captions/voiceover no longer drop the last few seconds of long (~2 min+) recordings.

📦 **Download:** [macOS DMGs on the Releases page](https://github.com/ankur-helak/openscreen/releases/latest) — Apple Silicon & Intel.

If you don't want to pay $29/month for Screen Studio but want a version that does what most people seem to need - quick, polished product demos and walkthroughs you'd post on X, Reddit or Youtube. OpenScreen does not offer every Screen Studio feature, but covers a lot of the core functionality.

Screen Studio is an awesome product and this is definitely not a 1:1 clone. If you just want something fully free and open source, this project should cover most of your needs.

**100% free** for both **personal** and **commercial** use. Use it, modify it, distribute it. Please respect the License. 

> [!NOTE]
>Software should be accessible. OpenScreen has no paid tiers, premium features, upsells, or functionality locked behind a paywall.

<p align="center">
	<img src="public/demo.png" alt="" style="height: 0.2467; margin-right: 12px;" />
  <img src="public/sample.png" alt="" style="height: 0.2467; margin-right: 12px;" />
</p>

## Core Features
- Record a specific window, or your whole screen.
- Record microphone and system audio.
- Webcam overlay with picture-in-picture, drag-to-position, mirroring, and shape options.
- Auto or manual zooms with adjustable depth, duration, easing, and pixel-precise position; auto-zoom follows your cursor as you work.
- Custom cursor size, smoothing, and click effects, with cursor themes and post-recording path smoothing.
- AI voiceover: generate natural-sounding narration entirely on-device from a script — no cloud, works offline.
- AI script polish (optional, cloud): rewrite the transcript with OpenAI using your own API key — per-segment and in place, so voiceover and captions stay in sync. Key stored encrypted on-device; only the text is sent.
- AI doc export (optional, cloud): turn a recording into a visual product walkthrough (self-contained HTML + PDF) with interaction-anchored steps and composited screenshots, via a multimodal OpenAI call using your own key.
- Automatic captions, generated on-device with no upload (works offline), and optionally linked to the AI voiceover so the on-screen text stays in sync with the narration.
- Wallpapers, solid colors, gradients, or your own background image.
- Motion blur.
- Crop, trim, and per-segment speed control on the timeline.
- Text, arrow, and image annotations, with text animation presets.
- Timeline snapping guides and an audio waveform to make trimming easier.
- Customizable keyboard shortcuts.
- Export to MP4 or GIF in multiple aspect ratios and resolutions.
- Languages supported: Arabic, English, Spanish, French, Italian, Japanese, Korean, Portuguese (Brazil), Russian, Turkish, Vietnamese, Simplified Chinese, and Traditional Chinese.


## Installation

> **This is a fork** with extra features (on-device **AI voiceover**, script-linked captions, cloud **AI script polish**, and macOS packaging fixes). Prebuilt **macOS** DMGs for this fork are published on the [fork's GitHub Releases](https://github.com/ankur-helak/openscreen/releases) page. The Homebrew, winget, and Nix instructions below track the original upstream project and won't include these fork-only features.

Download the latest installer for your platform from the [GitHub Releases](https://github.com/ankur-helak/openscreen/releases) page.

### macOS

The easiest way to install on macOS is via [Homebrew](https://brew.sh):

```bash
brew install --cask siddharthvaddem/openscreen/openscreen
```

Brew automatically picks the right build for Apple Silicon or Intel, and verifies the download against a notarized signature so Gatekeeper won't block it.

To update later: `brew upgrade --cask openscreen`
To uninstall: `brew uninstall --cask openscreen` (add `--zap` to also remove app data)

#### Manual install (if you prefer)

If you'd rather grab the `.dmg` directly from the [Releases page](https://github.com/ankur-helak/openscreen/releases) and encounter Gatekeeper blocking the app, you can bypass it by running the following command in your terminal after installation:

```bash
xattr -rd com.apple.quarantine /Applications/Openscreen.app
```

Note: Give your terminal Full Disk Access in **System Settings > Privacy & Security** to grant you access and then run the above command.

After running this command, proceed to **System Preferences > Security & Privacy** to grant the necessary permissions for "screen recording" and "accessibility". Once permissions are granted, you can launch the app.

> [!NOTE]
> **Upgrading from an older version and hitting permission issues?** If you already had OpenScreen installed and the new version won't record (Screen Recording or Accessibility keep failing even after you grant them), uninstall the old version, remove OpenScreen's existing entries under **System Settings > Privacy & Security** (both Screen Recording and Accessibility), then do a fresh install and grant the permissions again when prompted.

### Windows

Install via [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/):

```bash
winget install SiddharthVaddem.OpenScreen
```

To update later: `winget upgrade SiddharthVaddem.OpenScreen`
To uninstall: `winget uninstall SiddharthVaddem.OpenScreen`

If you'd rather grab the `.exe` installer directly, download it from the [Releases page](https://github.com/siddharthvaddem/openscreen/releases).

### Linux

Three packages are published to the [Releases page](https://github.com/siddharthvaddem/openscreen/releases) for each version. Pick the one that matches your distro:

**Debian / Ubuntu / Pop!_OS (`.deb`)**
```bash
sudo apt install ./Openscreen-Linux-latest.deb
```

**Arch / Manjaro (`.pacman`)**
```bash
sudo pacman -U Openscreen-Linux-latest.pacman
```

**Any distro (`.AppImage`)**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

**NixOS / Nix (flake)**

Try without installing:
```bash
nix run github:siddharthvaddem/openscreen
```

Install into your user profile:
```bash
nix profile install github:siddharthvaddem/openscreen
```

For a NixOS system config (flake):
```nix
{
  inputs.openscreen.url = "github:siddharthvaddem/openscreen";

  outputs = { nixpkgs, openscreen, ... }: {
    nixosConfigurations.<host> = nixpkgs.lib.nixosSystem {
      modules = [
        openscreen.nixosModules.default
        { programs.openscreen.enable = true; }
      ];
    };
  };
}
```

For Home Manager, use `openscreen.homeManagerModules.default` with the same `programs.openscreen.enable = true;`.

You may need to grant screen recording permissions depending on your desktop environment.

**Sandbox error:** If the AppImage fails to launch with a "sandbox" error, run it with `--no-sandbox`:
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

### Platform differences

Everything in the editor and export is the same on macOS, Windows, and Linux: zooms, backgrounds, motion blur, crop/trim/speed, blur regions, annotations, auto-captions, projects, export, and all languages. The differences are in **capture**, where macOS and Windows use a native pipeline that Linux doesn't have:

- **Native recording**: macOS (ScreenCaptureKit) and Windows (Windows Graphics Capture) record through a native pipeline for higher quality and clean window-level capture. Linux records through the browser pipeline instead.
- **Custom cursors**: on macOS and Windows the real cursor is captured (shape, type, and clicks), which powers the cursor themes, click effects, and editable cursor overlay. On Linux only the cursor position is captured (used for auto-zoom), so those cursor options aren't available.
- **Webcam**: captured natively on macOS and Windows; on Linux it's recorded through the browser, but still works as a picture-in-picture overlay.
- **System audio** support varies by OS:
  - **macOS**: requires macOS 13+. On macOS 14.2+ you'll be prompted to grant audio capture permission. macOS 12 and below can't capture system audio (mic still works).
  - **Windows**: works out of the box.
  - **Linux**: needs PipeWire (default on Ubuntu 22.04+, Fedora 34+). Older PulseAudio-only setups may not capture system audio (mic should still work).

---

## License

This project is licensed under the [MIT License](./LICENSE). By using this software, you agree that the authors are not liable for any issues, damages, or claims arising from its use.
