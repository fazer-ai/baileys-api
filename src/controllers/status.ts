import { authMiddleware } from "@/middlewares/auth";
import Elysia from "elysia";

const statusController = new Elysia({
  prefix: "/status",
  detail: {
    tags: ["Status"],
    security: [{ xApiKey: [] }],
  },
})
  .get("", () => "OK", {
    detail: {
      responses: {
        200: {
          description: "Server running",
        },
      },
    },
  })
  .use(authMiddleware)
  .get("/auth", () => "OK", {
    detail: {
      responses: {
        200: {
          description: "Authenticated",
        },
      },
    },
  });

// biome-ignore lint/style/noDefaultExport: <explanation>
export default statusController;
