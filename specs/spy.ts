import { spyOn } from "bun:test";
import logger from "@/lib/logger";

const infoSpy = spyOn(logger, "info");
const errorSpy = spyOn(logger, "error");

const spy = {
  logger: {
    info: infoSpy,
    error: errorSpy,
  },
};

// biome-ignore lint/style/noDefaultExport: <explanation>
export default spy;
