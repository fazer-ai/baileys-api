import Elysia, { t } from "elysia";
import baileys from "@/baileys";
import { authMiddleware } from "@/middlewares/auth";
import { jid, phoneNumberParams } from "./connections/types";

const groupsController = new Elysia({
  prefix: "/groups",
  detail: {
    tags: ["Groups"],
    security: [{ xApiKey: [] }],
  },
})
  .use(authMiddleware)
  .post(
    "/:phoneNumber/create",
    async ({ params, body }: { params: any; body: any }) => {
      const { phoneNumber } = params;
      const { subject, participants } = body;

      const group = await baileys.groupCreate(
        phoneNumber,
        subject,
        participants,
      );
      return { data: group };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        subject: t.String({ description: "Group subject", minLength: 1 } as any),
        participants: t.Array(jid("participant jid")),
      }),
      detail: {
        responses: {
          200: {
            description: "Group created",
            content: {
              "application/json": {
                schema: t.Object({
                  data: t.Object({
                    id: t.String(),
                    subject: t.String(),
                    subjectOwner: t.Optional(t.String()),
                    subjectTime: t.Optional(t.Number()),
                    size: t.Optional(t.Number()),
                    creation: t.Optional(t.Number()),
                    owner: t.Optional(t.String()),
                    desc: t.Optional(t.String()),
                    descId: t.Optional(t.String()),
                    restrict: t.Optional(t.Boolean()),
                    announce: t.Optional(t.Boolean()),
                    participants: t.Array(
                      t.Object({
                        id: t.String(),
                        admin: t.Union([
                          t.Literal("admin"),
                          t.Literal("superadmin"),
                          t.Null(),
                        ]),
                      }),
                    ),
                    ephemeralDuration: t.Optional(t.Number()),
                    inviteCode: t.Optional(t.String()),
                  }),
                }),
              },
            },
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/leave",
    async ({ params, body }: { params: any; body: any }) => {
      const { phoneNumber } = params;
      const { id } = body;

      await baileys.groupLeave(phoneNumber, id);
      return { message: "Left group" };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        id: jid("group jid"),
      }),
      detail: {
        responses: {
          200: { description: "Left group successfully" },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/update-subject",
    async ({ params, body }: { params: any; body: any }) => {
      const { phoneNumber } = params;
      const { id, subject } = body;

      await baileys.groupUpdateSubject(phoneNumber, id, subject);
      return { message: "Subject updated" };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        id: jid("group jid"),
        subject: t.String({ minLength: 1 } as any),
      }),
      detail: {
        responses: {
          200: { description: "Subject updated successfully" },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/update-description",
    async ({ params, body }: { params: any; body: any }) => {
      const { phoneNumber } = params;
      const { id, description } = body;

      await baileys.groupUpdateDescription(phoneNumber, id, description);
      return { message: "Description updated" };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        id: jid("group jid"),
        description: t.String(),
      }),
      detail: {
        responses: {
          200: { description: "Description updated successfully" },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/participants-update",
    async ({ params, body }: { params: any; body: any }) => {
      const { phoneNumber } = params;
      const { id, participants, action } = body;

      const response = await baileys.groupParticipantsUpdate(
        phoneNumber,
        id,
        participants,
        action,
      );
      return { data: response };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        id: jid("group jid"),
        participants: t.Array(jid("participant jid")),
        action: t.Union([
          t.Literal("add"),
          t.Literal("remove"),
          t.Literal("promote"),
          t.Literal("demote"),
        ]),
      }),
      detail: {
        responses: {
          200: {
            description: "Participants updated",
            content: {
              "application/json": {
                schema: t.Object({
                  data: t.Array(
                    t.Object({
                      status: t.String(),
                      jid: t.String(),
                      content: t.Optional(t.Any()),
                    }),
                  ),
                }),
              },
            },
          },
        },
      },
    },
  )
  .get(
    "/:phoneNumber/invite-code",
    async ({ params, query }: { params: any; query: any }) => {
      const { phoneNumber } = params;
      const { id } = query;

      const code = await baileys.groupInviteCode(phoneNumber, id);
      return { data: { code } };
    },
    {
      params: phoneNumberParams,
      query: t.Object({
        id: jid("group jid"),
      }),
      detail: {
        responses: {
          200: {
            description: "Invite code retrieved",
            content: {
              "application/json": {
                schema: t.Object({
                  data: t.Object({
                    code: t.String(),
                  }),
                }),
              },
            },
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/revoke-invite",
    async ({ params, body }: { params: any; body: any }) => {
      const { phoneNumber } = params;
      const { id } = body;

      const code = await baileys.groupRevokeInvite(phoneNumber, id);
      return { data: { code } };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        id: jid("group jid"),
      }),
      detail: {
        responses: {
          200: {
            description: "Invite code revoked",
            content: {
              "application/json": {
                schema: t.Object({
                  data: t.Object({
                    code: t.String(),
                  }),
                }),
              },
            },
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/accept-invite",
    async ({ params, body }: { params: any; body: any }) => {
      const { phoneNumber } = params;
      const { code } = body;

      const id = await baileys.groupAcceptInvite(phoneNumber, code);
      return { data: { id } };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        code: t.String({ description: "Invite code" } as any),
      }),
      detail: {
        responses: {
          200: {
            description: "Invite accepted",
            content: {
              "application/json": {
                schema: t.Object({
                  data: t.Object({
                    id: t.String(), // group jid
                  }),
                }),
              },
            },
          },
        },
      },
    },
  )
  .get(
    "/:phoneNumber/invite-info",
    async ({ params, query }: { params: any; query: any }) => {
      const { phoneNumber } = params;
      const { code } = query;

      const info = await baileys.groupGetInviteInfo(phoneNumber, code);
      return { data: info };
    },
    {
      params: phoneNumberParams,
      query: t.Object({
        code: t.String(),
      }),
      detail: {
        responses: {
          200: {
            description: "Invite info retrieved",
            content: {
              "application/json": {
                schema: t.Object({
                  data: t.Object({
                    id: t.String(), // Group Id
                    subject: t.Optional(t.String()),
                    subjectOwner: t.Optional(t.String()),
                    subjectTime: t.Optional(t.Number()),
                    size: t.Optional(t.Number()),
                    creation: t.Optional(t.Number()),
                    owner: t.Optional(t.String()),
                    desc: t.Optional(t.String()),
                    descId: t.Optional(t.String()),
                    restrict: t.Optional(t.Boolean()),
                    announce: t.Optional(t.Boolean()),
                    participants: t.Optional(
                      t.Array(
                        t.Object({
                          id: t.String(),
                          admin: t.Union([
                            t.Literal("admin"),
                            t.Literal("superadmin"),
                            t.Null(),
                          ]),
                        }),
                      ),
                    ),
                  }),
                }),
              },
            },
          },
        },
      },
    },
  )
  .get(
    "/:phoneNumber/participating",
    async ({ params }: { params: any }) => {
      const { phoneNumber } = params;
      const groups = await baileys.groupFetchAllParticipating(phoneNumber);
      return { data: groups };
    },
    {
      params: phoneNumberParams,
      detail: {
        responses: {
          200: {
            description: "Participating groups retrieved",
            content: {
              "application/json": {
                schema: t.Object({
                  data: t.Record(
                    t.String(), // Group Jid
                    t.Object({
                      id: t.String(),
                      subject: t.String(),
                      subjectOwner: t.Optional(t.String()),
                      subjectTime: t.Optional(t.Number()),
                      size: t.Optional(t.Number()),
                      creation: t.Optional(t.Number()),
                      owner: t.Optional(t.String()),
                      desc: t.Optional(t.String()),
                      descId: t.Optional(t.String()),
                      restrict: t.Optional(t.Boolean()),
                      announce: t.Optional(t.Boolean()),
                      participants: t.Array(
                        t.Object({
                          id: t.String(),
                          admin: t.Union([
                            t.Literal("admin"),
                            t.Literal("superadmin"),
                            t.Null(),
                          ]),
                        }),
                      ),
                    }),
                  ),
                }),
              },
            },
          },
        },
      },
    },
  );

export default groupsController;
