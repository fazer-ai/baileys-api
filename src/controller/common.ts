import { t } from "elysia";

export const phoneNumberParams = t.Object({
  phoneNumber: t.String({
    minLength: 13,
    maxLength: 14,
    description: "Phone number for connection",
  }),
});

export class PhoneStatusNotFoundError extends Error {
  constructor() {
    super("Status requested not found");
  }
}
