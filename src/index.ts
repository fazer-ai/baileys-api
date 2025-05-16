import app from "@/app";
import baileys from "@/baileys";
import config from "@/config";
import { errorToString } from "@/helpers/errorToString";
import logger, { deepSanitizeObject } from "@/lib/logger";
import { initializeRedis } from "@/lib/redis";

app.listen(config.port, () => {
  logger.info(
    `${config.packageInfo.name}@${config.packageInfo.version} running on ${app.server?.hostname}:${app.server?.port}`,
  );
  logger.info(
    "Loaded config %s",
    JSON.stringify(
      deepSanitizeObject(config, { omitKeys: ["password"] }),
      null,
      2,
    ),
  );

  initializeRedis().then(() =>
    baileys.reconnectFromAuthStore().catch((error) => {
      logger.error(
        "Failed to reconnect from auth store: %s",
        errorToString(error),
      );
    }),
  );
});
