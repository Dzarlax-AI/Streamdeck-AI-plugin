import { rmSync } from 'node:fs';

rmSync(new URL('../com.dzarlax.ai-assistant.sdPlugin', import.meta.url), { recursive: true, force: true });
