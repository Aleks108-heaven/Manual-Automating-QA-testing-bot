import { fileURLToPath } from "node:url";

/** The bot's own folder, found from this file and not from the working directory, so a host that starts elsewhere still reads the right files. */
export const BOT_ROOT = fileURLToPath(new URL("..", import.meta.url));
