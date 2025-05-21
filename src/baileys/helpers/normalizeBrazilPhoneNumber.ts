/**
 * @description Normalize Brazilian phone numbers.
 * The internal WhatsApp ID (JID) for Brazilian phone numbers does not always include the extra digit 9,
 * which is commonly used in Brazil.
 *
 * @param phoneNumber The phone number to normalize.
 * @returns The same phone number if does not need normalizing, or the phone number with the extra digit 9 added.
 */
export function normalizeBrazilPhoneNumber(phoneNumber: string): string {
  const match = phoneNumber.match(/^\+55(\d{2})(\d{8})$/);
  if (!match) {
    return phoneNumber;
  }
  const [, ddd, number] = match;
  return `+55${ddd}9${number}`;
}
