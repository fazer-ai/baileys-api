import Elysia from "elysia";
import baileys from "@/baileys";
import { adminGuard } from "@/middlewares/auth";

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

export default adminController;
