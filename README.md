![AI Assistant](Thumbnail.png)

# AI Assistant - Stream Deck Plugin

AI-powered text processing plugin for Elgato Stream Deck. Capture selected text or clipboard content, send it to an AI provider, and get the result pasted back or copied to clipboard.

## Features

- **Multiple AI providers**: OpenAI, Anthropic Claude, Google Gemini, OpenRouter, or any custom OpenAI-compatible endpoint
- **9 built-in presets**: Fix Grammar, Translate (EN/RU/SR/DE), Summarize, Explain Code, Professional & Casual rewrites
- **Two action types**:
  - **AI Text Action** — regular key with fully customizable prompts
  - **AI Prompt Selector** — Stream Deck+ encoder with quick preset switching via dial rotation
- **Custom prompts** with `{{text}}` template variable
- **Clipboard & selection modes** — process selected text or clipboard content

## Requirements

- Stream Deck software **7.1 or newer**
- **macOS 13.5+** (Intel or Apple Silicon), or **Windows 10/11 64-bit**
- **Node.js 24+** for development; Stream Deck manages the plugin's Node.js runtime
- An API key for the chosen AI provider

## Installation

1. Download the latest release from [Releases](https://github.com/dzarlax/streamdeck-ai-plugin/releases)
2. Double-click the `.streamDeckPlugin` file to install
3. The plugin will appear in Stream Deck under the **AI Assistant** category

## Configuration

1. Drag an **AI Text Action** or **AI Prompt Selector** to your Stream Deck
2. Select a preset, input source, and result behavior. Expand **Custom prompt** to edit the prompts.
3. Expand **AI connection**, select your provider, and enter your API key. These settings are shared by every AI action.
4. Choose a model or enter its ID manually. **Fetch** loads available models through the plugin. **Check access** reads the catalog; for OpenRouter this public catalog does not verify the key. **Test generation** separately sends a fixed, impersonal prompt and uses tokens.
5. Expand **Advanced parameters** for temperature, token limit, and timeout. Changes save automatically.

For Custom, enter an HTTP(S) API root such as `https://host.example/proxy/v1`, or a complete endpoint such as `https://host.example/v1/chat/completions`. Existing nonstandard endpoint paths remain exact POST destinations. Model discovery for those paths is best effort; their model ID can be entered manually. A Custom URL is never used for a built-in provider.

On macOS, allow Stream Deck's keyboard automation in **System Settings → Privacy & Security → Accessibility** when prompted. If Copy is blocked or does not update the clipboard, selection mode stops before sending an API request. On Windows, use a normal desktop session and compatible privilege levels for Stream Deck and the target editor.

## Usage

### AI Text Action (Key)
- Press the key to capture selected text (or clipboard), process it through AI, and paste/copy the result
- Customize the system prompt and user template per key

### AI Prompt Selector (Encoder / Stream Deck+)
- **Rotate** the dial to switch between presets
- **Press** or **tap** to execute the selected preset
- Enable/disable and reorder presets in the Property Inspector
- Use the arrow buttons or drag a preset to change its order

Only one AI operation runs at a time across all buttons and encoders. Additional presses show an alert and do not queue another capture. Clipboard changes are used to verify Copy; a clipboard manager or another application changing the clipboard at the same instant cannot be attributed to a particular producer.

## Building from Source

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run pack
streamdeck link com.dzarlax.ai-assistant.sdPlugin
```

The installer manifest version is derived from `package.json` (for example, `1.0.4` becomes `1.0.4.0`). The source manifest is kept in sync for tooling. The npm SDK version and the manifest's `SDKVersion` are independent version numbers.

## Native QA on macOS and Windows

Run `npm run qa:native` on each computer to check native clipboard access without reading or changing its contents. The Stream Deck device does not need to be connected.

`npm run qa:sdk -- /path/to/disposable/built.sdPlugin` starts the real bundled SDK against loopback WebSocket and API fixtures, checking registration and correlated catalog, access, and generation-test replies for a key and encoder. It does not connect to the Stream Deck application or external AI providers.

To exercise native Copy, put `Stream Deck QA — Привет 😀 $&` in a disposable editor document and select it. Run `npm run qa:native -- --selection`, then focus the editor within five seconds. The script checks the captured text without sending it to an API. This optional check changes the clipboard through the editor's Copy command.

For device acceptance, install the locally built plugin, verify a button and encoder/touch action, selection and clipboard modes, Copy Only and Paste, repeated presses while busy, and recovery after an API error. Installation and these physical-device checks are separate from the isolated automated tests.

Validation status for 1.0.6: the user confirmed operation on a Mac with a physical Stream Deck on November 17, 2026. Native Windows acceptance is deferred; Windows code paths have isolated regression coverage only.

## Privacy

Your text is sent directly from your computer to the selected AI provider's API. The plugin does not collect analytics, telemetry, or personal data. See [Privacy Policy](PRIVACY.md) for details.

## License

[MIT](LICENSE)

Generation tests use the same provider request builder as actions, with a reduced output budget: 1 token for a known nonreasoning model, up to 128 for reasoning or unknown models. Input tokens are billed separately. The budget is never raised automatically. A nonempty short response verifies the probe; accepted requests without visible text remain inconclusive. The normal output limit is not tested. Only a structured unsupported-temperature rejection can trigger one retry (Custom is never retried). Custom servers may ignore parameters, so their budget enforcement cannot be proven by this test. No clipboard content or action prompts are sent.

Model metadata and learned temperature omissions are held in bounded, one-hour session caches. A learned profile is tied to the provider, endpoint, key, model, temperature, and normal token limit. Unknown capabilities remain unknown; model access and parameter semantics require provider confirmation. Ordinary actions reject empty, blocked, or truncated responses before copying or pasting.
