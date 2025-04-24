import baileys from "@/baileys";
import { adminGuard } from "@/middlewares/auth";
import Elysia from "elysia";

const adminController = new Elysia({
  prefix: "/admin",
  detail: {
    tags: ["Admin"],
    security: [{ xApiKey: [] }],
  },
})
  .use(adminGuard)
  .post("/connections/logout-all", async () => await baileys.logoutAll(), {
    detail: {
      responses: {
        200: {
          description: "Initiated logout for all connections",
        },
      },
    },
  });

// biome-ignore lint/style/noDefaultExport: <explanation>
export default adminController;
