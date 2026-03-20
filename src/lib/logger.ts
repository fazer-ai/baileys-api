import path, { join } from "node:path";
import pino from "pino";
import type { PrettyOptions } from "pino-pretty";
import config from "@/config";

function omitKeys(obj: Record<string, unknown>, keys: string[]) {
  for (const key in obj) {
    if (keys.includes(key)) {
      obj[key] = "********";
    }
  }
}

function sanitizeItem(
  item: unknown,
  options?: DeepSanitizeObjectOptions,
): unknown {
  if (typeof item === "string") {
    return `${item.slice(0, 50)}${item.length > 50 ? "..." : ""}`;
  }
  if (Array.isArray(item) || item instanceof Set) {
    const arr = Array.from(item);
    const maxItems = 3;
    const sanitized = arr
      .slice(0, maxItems)
      .map((i) => sanitizeItem(i, options));
    if (arr.length > maxItems) {
      sanitized.push(`... and ${arr.length - maxItems} more`);
    }
    return sanitized;
  }
  if (typeof item === "object") {
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj);
    const maxKeys = 20;
    if (keys.length > maxKeys) {
      const truncated: Record<string, unknown> = {};
      for (const key of keys.slice(0, maxKeys)) {
        truncated[key] = sanitizeItem(obj[key], options);
      }
      truncated["..."] = `${keys.length - maxKeys} more keys`;
      return truncated;
    }
    return deepSanitizeObject(obj, options);
  }
  return item;
}

interface DeepSanitizeObjectOptions {
  omitKeys?: string[];
}

export function deepSanitizeObject(
  obj: Record<string, unknown>,
  options?: DeepSanitizeObjectOptions,
) {
  const output = structuredClone(obj);
  if (options?.omitKeys) {
    omitKeys(output, options.omitKeys);
  }

  for (const key in output) {
    output[key] = sanitizeItem(output[key], options);
  }

  return output;
}

const isDev = config.env === "development";

function buildDevTransport(
  level: string,
  logFile: string,
): pino.TransportMultiOptions {
  return {
    targets: [
      {
        level,
        target: "pino-roll",
        options: {
          file: path.join("logs", logFile),
          size: "50m",
          limit: { count: 10 },
        },
      },
      {
        level,
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
        } as PrettyOptions,
      },
    ],
  };
}

export const baileysLogger = pino({
  level: isDev ? "debug" : (config.baileys.logLevel as string),
  ...(isDev && {
    transport: buildDevTransport(config.baileys.logLevel as string, "baileys"),
  }),
});

let logger = pino({
  level: isDev ? "debug" : (config.logLevel as string),
  ...(isDev && {
    transport: buildDevTransport(config.logLevel as string, "log"),
  }),
});

if (config.env === "development") {
  logger = require("pino-caller")(logger, {
    relativeTo: join(__dirname, ".."),
  });
}

export default logger;
