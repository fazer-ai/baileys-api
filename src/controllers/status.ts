import Elysia from "elysia";
import { authMiddleware } from "@/middlewares/auth";

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

export default statusController;
