import {
  fetchLatestWaWebVersion,
  type WAVersion,
} from "@whiskeysockets/baileys";
import config from "@/config";
import logger from "@/lib/logger";

export async function fetchBaileysClientVersion(): Promise<WAVersion> {
  const { version } = await fetchLatestWaWebVersion({});

  if (config.baileys.overrideClientVersion) {
    if (config.baileys.clientVersion === "default") {
      logger.warn(
        "BAILEYS_OVERRIDE_CLIENT_VERSION is set to true but BAILEYS_CLIENT_VERSION is unset. Using latest version %s instead.",
        version.join("."),
      );
      return version;
    }
    if (/^\d+\.\d+\.\d+$/.test(config.baileys.clientVersion)) {
      return config.baileys.clientVersion
        .split(".")
        .map((v) => Number(v)) as WAVersion;
    }
    logger.warn(
      "Invalid BAILEYS_CLIENT_VERSION format, expected semver (e.g. 2.2314.13). Falling back to latest version %s instead.",
      version.join("."),
    );
  } else if (config.baileys.clientVersion !== "default") {
    logger.warn(
      "BAILEYS_CLIENT_VERSION is set to version %s without BAILEYS_OVERRIDE_CLIENT_VERSION. Remove this variable to suppress this warning, or set BAILEYS_OVERRIDE_CLIENT_VERSION to true to use the specified version. Using latest version %s instead.",
      config.baileys.clientVersion,
      version.join("."),
    );
  }

  return version;
}
